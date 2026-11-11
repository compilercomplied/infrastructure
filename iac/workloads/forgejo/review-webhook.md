# Organization review webhook constraints

The [configured provider](../../Pulumi.yaml) exposes repository hooks, whose
required repository identity cannot represent an organization hook. The
[dynamic provider](review-webhook.ts) uses the organization API so one hook can
cover existing and future repositories without a runtime reconciliation service.

Adoption must preserve the existing hook rather than creating another one:
duplicate delivery can trigger duplicate work, and replacement can interrupt
reviews. Ambiguous or changed identities therefore fail closed. Protection and
retention prevent removing the IaC declaration from silently deleting the live
hook; retirement requires an explicit owner decision.

## Secret rotation is not a normal update

The Forgejo API behavior targeted by this provider does not update the HMAC secret
through PATCH and does not expose it through GET. A successful readback therefore
cannot prove that signing secrets agree. Changing the desired secret is rejected
rather than reported as a successful rotation. Coordinate a supported owner-side
rotation and verify signed delivery before reconciling that input.

The API also has limitations around Actions events and authorization headers.
The provider rejects unsupported drift rather than partially applying the desired
configuration. Preserve those guards when changing event coverage.

To verify recovery, confirm the same hook identity in Forgejo and Pulumi, then
check signed event delivery in the receiving controller. This proves the hook
works; it does not establish that the controller can run a model or complete a
review. The [upstream edit implementation](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/routers/api/v1/utils/hook.go)
is the compatibility boundary for this provider.
