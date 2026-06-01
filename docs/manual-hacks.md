# Manual Hacks & Recovery Recipes

This document maintains a catalog of one-off cluster tasks, manual overrides, and recovery hacks that are not tracked in Pulumi code (e.g. for portability, schema limitations, or database bootstrapping).

---

## 🔒 Authentik Security Tuning

### 1. Disabling Public Self-Service Registration ("Sign up" Link)
To secure Authentik as a closed system where only administrators can provision users, you must remove the default enrollment flow from the identification stage.

#### Method A: Command-Line Database Override (Recommended)
You can run this database one-liner inside the `authentik-server` container to programmatically unlink the enrollment flow. This is extremely portable and works immediately:

```bash
kubectl exec -n selfhosted deployment/authentik-server -c server -- ak shell -c "from authentik.stages.identification.models import IdentificationStage; stage = IdentificationStage.objects.get(name='default-authentication-identification'); stage.enrollment_flow = None; stage.save()"
```

#### Method B: Admin UI Overrides
1. Navigate to your Authentik Portal (`https://auth.gdario.dev`) and log in as `akadmin`.
2. Open the sidebar and click **Flows and Stages > Flows**.
3. Under the **Flows** tab, click **`default-authentication-flow`**.
4. Go to the **Stage Bindings** tab.
5. Click **`default-authentication-identification`** to edit the stage.
6. Locate the **Enrollment flow** field, select **`None`** (clear it), and save.

### 2. Displaying Google SSO Button on the Login Page
For an external federated login source (like Google) to show up as a button on the default login screen, the source must be linked to the default identification stage.

#### Method A: Command-Line Database Override (Recommended)
Run this programmatically inside the `authentik-server` container to bind the Google source immediately:

```bash
kubectl exec -n selfhosted deployment/authentik-server -c server -- ak shell -c "from authentik.stages.identification.models import IdentificationStage; from authentik.sources.oauth.models import OAuthSource; stage = IdentificationStage.objects.get(name='default-authentication-identification'); source = OAuthSource.objects.get(slug='google'); stage.sources.add(source); stage.save()"
```

#### Method B: Admin UI Overrides
1. Navigate to your Authentik Portal (`https://auth.gdario.dev`) and log in as `akadmin`.
2. Go to **Flows and Stages > Stages**.
3. Edit the **`default-authentication-identification`** stage.
4. Scroll down to **Sources**, select **`Google`** in the list, and click **Update**.

### 3. Disabling Google OAuth Self-Service Signup (Clearing Enrollment Flow)
To strictly prevent unrecognized Google accounts from registering (enrolling) in your system while letting matching pre-created profiles log in, you must clear the enrollment flow on the Google OAuth Source.

#### Method A: Command-Line Database Override (Recommended)
Run this one-liner inside the `authentik-server` container to immediately disconnect the enrollment flow:

```bash
kubectl exec -n selfhosted deployment/authentik-server -c server -- ak shell -c "from authentik.sources.oauth.models import OAuthSource; s = OAuthSource.objects.get(slug='google'); s.enrollment_flow = None; s.save()"
```

#### Method B: Admin UI Overrides
1. Navigate to your Authentik Portal (`https://auth.gdario.dev`) and log in as `akadmin`.
2. Go to **Directory > Federation and Social login**.
3. Click the **Edit** icon next to the **Google** source.
4. Expand the **Advanced settings** section.
5. Locate the **Enrollment flow** dropdown, clear the selection (set it to `---------` / `None`), and click **Update**.

---

## 🔑 Administrative Recovery

### 1. Manual Admin (`akadmin`) Password Reset
If the bootstrap password fails, is lost, or gets locked out, you can force a password reset directly inside the Django runtime database without going through OIDC or recovery emails:

```bash
kubectl exec -n selfhosted deployment/authentik-server -c server -it -- ak shell -c "from authentik.core.models import User; u = User.objects.get(username='akadmin'); u.set_password('NEW_SECURE_PASSWORD'); u.save()"
```

### 2. Hardcoded Flow UUIDs in Pulumi Infrastructure (The OIDC Redirect Hack)

When configuring OAuth Sources (like Google) in Pulumi, binding the source to the correct flows is critical to ensuring the OIDC login context is preserved (so users are properly redirected back to applications like Tandoor Recipes instead of the Authentik dashboard).

Currently, the Pulumi Authentik provider lacks data sources for querying some of the default built-in flows by name. As a workaround ("hack"), we hardcode the static UUIDs of Authentik's default flows directly into the `authentik.SourceOauth` configuration in `authentik-resources.ts`.

These are the globally static UUIDs assigned by Authentik to its default flows:
- **`default-source-authentication`**: `a7c56c41-379d-417c-9885-f0d55e174317`
- **`default-source-enrollment`**: `96f96a88-5eec-46fd-9943-ba706bfdc8be`

If Authentik ever changes these IDs in a future major release (which is rare, as they are seeded data), these may need to be manually updated by checking `ak shell`:
```bash
kubectl exec -n selfhosted deployment/authentik-server -c server -- ak shell -c "from authentik.flows.models import Flow; print([(f.slug, str(f.pk)) for f in Flow.objects.all()])"
```
