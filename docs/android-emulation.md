# Docker and Android emulation

## Goal

Hermes and Forgejo CI should be able to compile code in containers and verify
Android applications in hardware-accelerated emulators. The cluster therefore
needs two related capabilities:

- isolated Docker daemons for builds and test containers; and
- controlled access to the node's `/dev/kvm` device for x86_64 Android
  emulators.

These are execution capabilities, not general host access. Workloads should
receive only the storage, network access, and device access needed for a build
or test. Host Docker sockets are not mounted into either workload.

## Node capability

Pulumi labels KVM-capable nodes with:

```text
ci.gdario.dev/android-kvm=true
```

Android workloads use this label as a `nodeSelector`. The label expresses a
placement capability; it does not grant access to KVM. The single-node cluster
is deliberately not tainted because a `NoSchedule` taint would also prevent
unrelated workloads from recovering on its only node.

The host owns `/dev/kvm` as `root:kvm`, where the current KVM group ID is 990.
Workloads that open the device need that supplementary group in addition to a
device mount or allocation. GID 990 is an environment-specific contract and
must be kept consistent on every node carrying the capability label.

## Hermes execution path

Hermes uses the generic device plugin in `kube-system`. The plugin advertises
one logical `devic.es/kvm` resource from `/dev/kvm`, and the Hermes container
requests one unit in both its requests and limits. This gives the scheduler an
explicit view of Hermes' KVM dependency and causes kubelet to inject the device
into the container.

The pod also receives supplementary GID 990. The main container is not
privileged: its s6 supervisor starts as root, while Hermes application and
gateway processes run as the `hermes` user. The dedicated DinD sidecar is the
only privileged container.

The Android image owns the immutable toolchain under `/opt/android-sdk`:

- Java 21;
- adb and platform tools;
- API 35 platform and build tools;
- the Google APIs x86_64 API 35 system image; and
- the Android emulator plus `emulator-start` helper.

The `hermes-agent-android-pvc` is mounted at `/opt/android-data`. It holds only
mutable state: AVD definitions, emulator snapshots, screenshots, and the Gradle
cache. Keeping the SDK in the image makes the toolchain reproducible while the
PVC lets virtual devices survive pod replacement.

Hermes' DinD sidecar stores its graph in an `emptyDir`. Docker state is
intentionally ephemeral; source code and other durable Hermes state belong on
the normal Hermes data PVC instead.

## Forgejo Android runner

`forgejo-android-runner` is a dedicated runner with capacity one. Its control
container talks to a privileged DinD sidecar over a Unix socket in an
`emptyDir`; it never mounts the host Docker socket. Job containers remain
ordinary Docker containers created by that daemon.

The runner is currently scaled to zero. The node has only two physical CPU
cores, and an emulator plus a build can starve the control plane and resident
applications. Enable it only after providing enough dedicated compute capacity
or accepting that contention explicitly.

The runner's KVM path is not yet equivalent to Hermes:

1. `/dev/kvm` is mounted directly into the privileged DinD sidecar with a
   `hostPath` volume.
2. Runner configuration asks DinD to pass `/dev/kvm` into each job container
   with `--device=/dev/kvm`.
3. The runner does not request `devic.es/kvm`, so Kubernetes does not account
   for this use or coordinate it with Hermes.

The configuration expresses the intended forwarding path, but it has not been
validated end to end with the runner enabled. A runner job must also provide
its own Android SDK or use a purpose-built Android build image; unlike Hermes,
the runner control image does not own the Android toolchain.

Before enabling the runner, converge it on the device-plugin allocation model
and run a real workflow that compiles an APK, boots an x86_64 AVD, installs and
launches the APK, sends an input event, and captures a screenshot.

## Concurrency and scheduling

Kubernetes extended resources are integer, non-overcommittable resources. The
device plugin currently advertises `devic.es/kvm=1`, so only one pod requesting
that resource can be scheduled at a time.

`/dev/kvm` itself supports multiple clients. If Hermes and CI should emulate
concurrently, configure the generic device plugin with an explicit logical
`count` and make every consumer request the resource. The count is a scheduling
policy, not a hardware limit; choose it from tested CPU and memory capacity.
Resource requests and limits must still prevent concurrent emulators from
exhausting the node.

Do not enable concurrency by adding more direct `hostPath` mounts. That bypasses
scheduler accounting and makes overload and access harder to audit.

## Network and privilege boundaries

- Hermes' main container is non-privileged; only its DinD sidecar is
  privileged.
- The Forgejo runner and its job containers are unprivileged; only its DinD
  sidecar is privileged.
- Neither workload mounts the host Docker socket.
- The Android runner opts out of service-account token mounting.
- The Android runner has explicit egress for DNS, Forgejo, the cluster ingress,
  and HTTPS artifact or registry downloads. Namespace default-deny policies
  remain the baseline.
- KVM is assigned only to pods placed on labelled nodes and requesting the
  declared capability. The runner's direct-hostPath exception must be removed
  before it is considered production-ready.

## Operational validation

After a change to the image, KVM plugin, node placement, or either workload,
verify the following without applying infrastructure manually:

1. `mise run preview-deployment` shows only the intended resources.
2. The KVM device-plugin DaemonSet is Ready.
3. The labelled node advertises the expected `devic.es/kvm` capacity.
4. The workload pod is Ready and the Android PVC remains Bound.
5. The main workload container is not privileged.
6. `/dev/kvm` is readable and writable by the emulator process.
7. `adb`, `emulator`, `sdkmanager`, and `emulator -accel-check` succeed.
8. DinD can start a container without the host Docker socket.
9. An API 35 AVD boots with KVM acceleration.
10. A test APK can be installed and launched, an input event can be sent, and
    a screenshot can be captured.
11. Replacing the workload pod preserves the AVD on its PVC.

For the Forgejo runner, perform these checks from a real `android-kvm` labelled
workflow so they cover the runner-to-DinD-to-job-container device path.

## Known follow-up work

- Set an `fsGroup` for Hermes' PVCs so the `hermes` application user can manage
  AVD and Gradle data without relying on root-owned directories.
- Re-layer and reduce the Android image. Its current large SDK layer makes cold
  pulls exceed the deployment readiness timeout.
- Align the deployment timeout with a legitimate cold pull, while retaining a
  bounded failure signal.
- Replace the Android runner's direct KVM `hostPath` with a device-plugin
  resource request and validate forwarding into job containers.
- Decide and document the supported emulator concurrency, then set the device
  plugin count and workload resource limits to match.
- Replace the fixed KVM GID contract if KVM-capable nodes become heterogeneous.

