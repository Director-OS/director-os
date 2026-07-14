export interface DirectorModuleStatus {
  name: string;
  status: "initialized" | "ready" | "degraded";
}

export const sharedModule = {
  name: "shared",
  status: "initialized"
} satisfies DirectorModuleStatus;
