export const renovateRuntimeConfig = {
  platform: "forgejo",
  endpoint: "https://git.gdario.dev/api/v1/",
  repositories: ["home/homelab-iac"],
  onboarding: false,
  requireConfig: "required",
} as const;
