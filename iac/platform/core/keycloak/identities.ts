import * as keycloak from "@pulumi/keycloak";
import * as pulumi from "@pulumi/pulumi";
import { oidcApps } from "../oidc-apps";
import { oidcClientSecret } from "../../../library/oidc-app";
import { getAuthorizedUsers } from "../../../workloads/selfhosted/users";
import { configureKeycloak } from "./index";

export const keycloakRealmName = "homelab";

export function configureKeycloakIdentities(foundation: ReturnType<typeof configureKeycloak>) {
  const config = new pulumi.Config("selfhosted");
  const identityConfig = new pulumi.Config("keycloakIdentity");
  const subjects = identityConfig.requireSecretObject<Record<string, string>>("googleSubjects");
  const authorizedUsers = getAuthorizedUsers();
  const validatedSubjects = subjects.apply(values => {
    if (Object.keys(values).length !== authorizedUsers.length ||
        authorizedUsers.some(user => !/^\d{10,40}$/.test(values[user.name] ?? "")) ||
        new Set(Object.values(values)).size !== authorizedUsers.length) {
      throw new Error("Google subject links must uniquely identify each authorized user");
    }
    return values;
  });
  const provider = new keycloak.Provider("homelab-keycloak", {
    url: foundation.url, realm: "master",
    clientId: foundation.automationClientId, clientSecret: foundation.automationSecret,
    initialLogin: false, keycloakVersion: "26.8.2",
  }, { dependsOn: [foundation.bootstrap] });
  const opts = { provider };
  const realm = new keycloak.Realm("homelab-identity-realm", {
    realm: keycloakRealmName, displayName: "GDario Labs", enabled: true,
    registrationAllowed: false, registrationEmailAsUsername: false,
    editUsernameAllowed: false, loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false, resetPasswordAllowed: false,
    sslRequired: "external", accessTokenLifespan: "1h",
    revokeRefreshToken: true, refreshTokenMaxReuse: 0,
  }, { ...opts, protect: true });
  const profile = new keycloak.RealmUserProfile("homelab-identity-profile", {
    realmId: realm.id, unmanagedAttributePolicy: "DISABLED",
    attributes: [
      { name: "username", permissions: { views: ["admin", "user"], edits: ["admin"] } },
      { name: "email", validators: [{ name: "email" }], permissions: { views: ["admin", "user"], edits: ["admin"] } },
      { name: "firstName", permissions: { views: ["admin", "user"], edits: ["admin", "user"] } },
      { name: "lastName", permissions: { views: ["admin", "user"], edits: ["admin", "user"] } },
    ],
  }, opts);
  // Disabling realm registration alone does not prevent a broker from creating users.
  // Known Google subjects are linked in IaC; every unlinked identity must be denied.
  const enrollment = new keycloak.authentication.Flow("homelab-prelinked-only", {
    realmId: realm.id, alias: "prelinked-identities-only", providerId: "basic-flow",
  }, opts);
  const denyEnrollment = new keycloak.authentication.Execution("homelab-deny-enrollment", {
    realmId: realm.id, parentFlowAlias: enrollment.alias,
    authenticator: "deny-access-authenticator", requirement: "REQUIRED", priority: 10,
  }, opts);
  const google = new keycloak.oidc.GoogleIdentityProvider("homelab-google", {
    realm: realm.id, alias: "google", displayName: "Google", enabled: true,
    clientId: identityConfig.require("googleClientId"), clientSecret: identityConfig.requireSecret("googleClientSecret"),
    defaultScopes: "openid profile email", trustEmail: true,
    storeToken: false, syncMode: "FORCE", firstBrokerLoginFlowAlias: enrollment.alias,
  }, { ...opts, dependsOn: [denyEnrollment] });
  const groupDefinitions = [
    { name: "hermes-users", members: ["gdario", "Andrea"] },
    { name: "grafana-admins", members: ["gdario"] },
    { name: "excalidash-admins", members: ["gdario"] },
  ];
  const groups = groupDefinitions.map(group => new keycloak.Group(`homelab-${group.name}`, {
    realmId: realm.id, name: group.name,
  }, opts));
  const users = authorizedUsers.map(user => {
    const identity = new keycloak.User(`homelab-user-${user.name.toLowerCase()}`, {
      realmId: realm.id, username: user.name.toLowerCase(), firstName: user.name,
      email: user.email, enabled: true, requiredActions: [],
      // A pre-linked user is not a first-broker enrollment: FORCE sync lets Google
      // establish email verification on login without asserting it before authentication.
      emailVerified: false,
      federatedIdentities: [{
        identityProvider: google.alias, userId: validatedSubjects.apply(values => values[user.name]), userName: user.email,
      }],
    }, { ...opts, dependsOn: [profile], ignoreChanges: ["email", "emailVerified", "firstName", "lastName"] });
    return identity;
  });
  const memberships = authorizedUsers.map((user, userIndex) => new keycloak.UserGroups(`homelab-user-${user.name.toLowerCase()}-groups`, {
    realmId: realm.id, userId: users[userIndex].id, exhaustive: true,
    groupIds: groups.filter((_, index) => groupDefinitions[index].members.includes(user.name)).map(group => group.id),
  }, opts));
  const groupsScope = new keycloak.openid.ClientScope("homelab-groups-scope", {
    realmId: realm.id, name: "homelab-groups", includeInTokenScope: true,
  }, opts);
  const groupMapping = new keycloak.openid.GroupMembershipProtocolMapper("homelab-groups-claim", {
    realmId: realm.id, clientScopeId: groupsScope.id,
    name: "groups", claimName: "groups", fullPath: false,
    addToAccessToken: true, addToIdToken: true, addToUserinfo: true,
  }, opts);
  const clientScopes: pulumi.Resource[] = [];
  const clients = oidcApps.map(app => {
    const client = new keycloak.openid.Client(`homelab-oidc-${app.key}`, {
      realmId: realm.id, clientId: app.clientId, name: app.name, enabled: true,
      accessType: "CONFIDENTIAL", clientSecret: oidcClientSecret(app, config),
      standardFlowEnabled: true, implicitFlowEnabled: false,
      directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
      fullScopeAllowed: false, validRedirectUris: [app.url + app.callbackPath],
      // Client overrides are raw seconds; the realm accepts duration syntax.
      webOrigins: [app.url], accessTokenLifespan: "3600",
    }, opts);
    clientScopes.push(new keycloak.openid.ClientDefaultScopes(`homelab-oidc-${app.key}-default-scopes`, {
      realmId: realm.id, clientId: client.id, defaultScopes: ["basic", "profile", "email", groupsScope.name],
    }, opts));
    clientScopes.push(new keycloak.openid.ClientOptionalScopes(`homelab-oidc-${app.key}-optional-scopes`, {
      realmId: realm.id, clientId: client.id, optionalScopes: app.scopes.includes("offline_access") ? ["offline_access"] : [],
    }, opts));
    return client;
  });
  return {
    realm, google, users, groups, clients,
    resources: [realm, profile, enrollment, denyEnrollment, google, ...users, ...groups, ...memberships, groupsScope, groupMapping, ...clients, ...clientScopes],
    issuer: pulumi.interpolate`${foundation.url}/realms/${realm.realm}`,
    googleCallback: pulumi.interpolate`${foundation.url}/realms/${realm.realm}/broker/${google.alias}/endpoint`,
    accountUrl: pulumi.interpolate`${foundation.url}/realms/${realm.realm}/account/`,
  };
}
