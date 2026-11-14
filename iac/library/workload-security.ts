import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function workloadPodSecurityContext(
  context: k8s.types.input.core.v1.PodSecurityContext = {},
): k8s.types.input.core.v1.PodSecurityContext {
  return { seccompProfile: { type: "RuntimeDefault" }, ...context };
}

export function workloadContainerSecurityContext(
  context: pulumi.Input<k8s.types.input.core.v1.SecurityContext> = {},
): pulumi.Output<pulumi.Unwrap<k8s.types.input.core.v1.SecurityContext>> {
  return pulumi.output(context).apply(resolved => {
    // DinD needs a privileged runtime; Kubernetes cannot honor these restrictions
    // there. Require that exception explicitly rather than emitting an invalid Pod.
    if (resolved.privileged) {
      if (resolved.allowPrivilegeEscalation === false ||
          resolved.capabilities?.drop?.length || resolved.capabilities?.add?.length ||
          (resolved.seccompProfile && resolved.seccompProfile.type !== "Unconfined")) {
        throw new Error("Privileged containers cannot use privilege-escalation, capability, or seccomp restrictions");
      }
      return resolved;
    }

    // Users and writable paths depend on each image's startup contract and PVC
    // ownership. Callers opt into non-root and read-only root independently.
    return {
      ...resolved,
      privileged: false,
      allowPrivilegeEscalation: resolved.allowPrivilegeEscalation ?? false,
      capabilities: { drop: ["ALL"], ...resolved.capabilities },
    };
  });
}

export function secureWorkloadContainer(
  container: k8s.types.input.core.v1.Container,
): k8s.types.input.core.v1.Container {
  return { ...container, securityContext: workloadContainerSecurityContext(container.securityContext) };
}
