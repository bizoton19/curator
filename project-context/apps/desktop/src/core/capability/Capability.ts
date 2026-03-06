export type CapabilityType =
  | "output-renderer"
  | "template-processor"
  | "estimation-engine"
  | "integration-connector"
  | "post-processing-agent";

export type CapabilityContext = {
  workspacePath: string;
};

export type CapabilityResult = {
  success: boolean;
  message?: string;
};

export interface Capability {
  id: string;
  name: string;
  description: string;
  type: CapabilityType;
  execute(context: CapabilityContext): Promise<CapabilityResult>;
}
