import * as keycloak from "@pulumi/keycloak";
import * as pulumi from "@pulumi/pulumi";
import { createAgentIdentities } from "../../../library/agent-identity";
import { oidcApps } from "../oidc-apps";
import { oidcClientSecret } from "../../../library/oidc-app";
import { getAuthorizedUsers } from "../../../workloads/selfhosted/users";
import { configureKeycloak } from "./index";

export const keycloakRealmName = "homelab";

export function configureKeycloakIdentities(foundation: ReturnType<typeof configureKeycloak>, agentIdentities: ReturnType<typeof createAgentIdentities>) {
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
  const realmManagement = keycloak.openid.getClientOutput({
    realmId: realm.id, clientId: "realm-management",
  }, opts);
  const realmAdmin = keycloak.getRoleOutput({
    realmId: realm.id, clientId: realmManagement.id, name: "realm-admin",
  }, opts);
  const administratorRoles: keycloak.UserRoles[] = [];
  const humanSubjects: Record<string, pulumi.Output<string>> = {};
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
    if (user.name === "gdario") {
      administratorRoles.push(new keycloak.UserRoles("homelab-user-gdario-admin", {
        realmId: realm.id, userId: identity.id, roleIds: [realmAdmin.id],
        // Preserve Keycloak's default account roles alongside the explicit admin grant.
        exhaustive: false,
      }, opts));
    }
    humanSubjects[user.name] = identity.id;
    return identity;
  });
  const memberships = authorizedUsers.map((user, userIndex) => new keycloak.UserGroups(`homelab-user-${user.name.toLowerCase()}-groups`, {
    realmId: realm.id, userId: users[userIndex].id, exhaustive: true,
    groupIds: groups.filter((_, index) => groupDefinitions[index].members.includes(user.name)).map(group => group.id),
  }, opts));
  const agentUsers = Object.values(agentIdentities).map(agent => {
    const user = new keycloak.User(`homelab-${agent.username}`, {
      realmId: realm.id, username: agent.username, firstName: agent.username,
      email: agent.email, emailVerified: false, enabled: true, requiredActions: [],
      initialPassword: { value: agent.password, temporary: false },
    }, { ...opts, dependsOn: [profile] });
    const membership = new keycloak.UserGroups(`homelab-${agent.username}-groups`, {
      realmId: realm.id, userId: user.id, exhaustive: true,
      groupIds: groups.filter((_, index) => groupDefinitions[index].name === "hermes-users" && [agentIdentities.hermes.username, agentIdentities.codex.username, agentIdentities.openclaw.username].includes(agent.username)).map(group => group.id),
    }, opts);
    return { name: agent.username, user, membership };
  });
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
      accessType: app.publicClient ? "PUBLIC" : "CONFIDENTIAL",
      clientSecret: app.publicClient ? undefined : oidcClientSecret(app, config),
      pkceCodeChallengeMethod: app.publicClient ? "S256" : undefined,
      standardFlowEnabled: true, implicitFlowEnabled: false,
      directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
      fullScopeAllowed: false, validRedirectUris: [app.url + app.callbackPath, ...(app.nativeRedirectUris ?? [])],
      validPostLogoutRedirectUris: app.postLogoutRedirectPath ? [app.url + app.postLogoutRedirectPath] : undefined,
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
  const operationsClient = new keycloak.openid.Client("homelab-agent-operations-client", {
    realmId: realm.id, clientId: "agent-operations", name: "Agent operations", enabled: true,
    accessType: "PUBLIC", standardFlowEnabled: false, implicitFlowEnabled: false,
    directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
    oauth2DeviceAuthorizationGrantEnabled: true, fullScopeAllowed: false,
  }, opts);
  // HITL binds approval to the user's subject; executor calls retain that same identity.
  const operationsAudience = new keycloak.openid.AudienceProtocolMapper("homelab-agent-operations-audience", {
    realmId: realm.id, clientId: operationsClient.id, name: "hitl-audience",
    includedCustomAudience: "hitl-auth-server", addToAccessToken: true, addToIdToken: false,
  }, opts);
  return {
    realm, google, users, groups, clients, agentUsers, humanSubjects,
    agentSubjects: Object.fromEntries(agentUsers.map(agent => [agent.name, agent.user.id])),
    resources: [realm, profile, enrollment, denyEnrollment, google, ...users, ...administratorRoles, ...groups, ...memberships, ...agentUsers.flatMap(agent => [agent.user, agent.membership]), groupsScope, groupMapping, ...clients, ...clientScopes, operationsClient, operationsAudience],
    issuer: pulumi.interpolate`${foundation.url}/realms/${realm.realm}`,
    googleCallback: pulumi.interpolate`${foundation.url}/realms/${realm.realm}/broker/${google.alias}/endpoint`,
    accountUrl: pulumi.interpolate`${foundation.url}/realms/${realm.realm}/account/`,
  };
}
