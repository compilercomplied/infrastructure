# OIDC identity contracts

Keep identity registration in one place because callback, client, issuer, and
secret mismatches can break login even when both services are healthy. The
[registration helper](../iac/library/oidc-app.ts) and
[registry](../iac/platform/core/oidc-apps.ts) supply the common contract;
application adapters handle differences in provisioning and configuration format.

An identity-provider registration does not create application accounts, grant
administrator privileges, or issue application API tokens. Those need explicit
application-side provisioning. Email matching links identities; it is not by
itself an enrollment restriction. The [blueprint](../iac/platform/core/templates/authentik-blueprints.yaml)
declares users and the Google enrollment flow, so do not rely on the retired
manual-user and enrollment-override instructions.

Preserve Authentik slugs and blueprint identifiers unless deliberately migrating
an identity: slugs participate in issuer URLs, and identifiers select existing
resources. Changing a client secret or ID must reconcile existing app-side
providers too; updating only Authentik can strand users. Use strict callback URLs
that agree with the externally visible app URL.

Blueprint entries are not automatically removed when a declaration disappears.
Retiring an integration needs an explicit removal decision so old login paths do
not survive a workload refactor. Store secrets through encrypted Pulumi config;
the blueprint refers to environment values rather than embedding credentials.
