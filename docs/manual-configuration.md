# Manual Configuration Guide

This document covers operational configurations and setups that must be handled manually by administrators, as they cannot or should not be fully automated via infrastructure-as-code for security or operational reasons.

---

## 👥 Authentik User Management

### Why Manual Provisioning is Required
To maximize security, we have completely disabled public self-service registration ("open enrollment") across all services. Because we configured the Google OAuth source's `userMatchingMode` to `email_link`, **new users cannot simply click "Log in with Google" to create an account.**

For a user to successfully authenticate via Google SSO into applications like Tandoor Recipes, an administrator must **first pre-provision their account manually** inside Authentik with a matching email address.

### How to Manually Add a User
1. Log in to the Authentik Admin Portal (`https://auth.gdario.dev`) as `akadmin`.
2. Navigate to **Directory > Users** in the left sidebar.
3. Click **Create** to add a new user.
4. Fill in the required details:
   * **Username**: A unique username (e.g., `gdario`).
   * **Name**: The user's full name.
   * **Email**: **[CRITICAL]** This must exactly match the email address they use for their Google Account. This is the anchor point for the `email_link` matching mode.
5. Click **Create**.
6. (Optional) You do not need to set a local password for this user if they will only be authenticating via Google SSO.

Once the user is created in the directory, they can immediately navigate to Tandoor Recipes (or any other SSO-integrated application), click **Log in with Google**, and Authentik will securely link their Google profile to this pre-provisioned local account.
