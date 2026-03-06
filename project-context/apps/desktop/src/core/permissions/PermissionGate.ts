export type PermissionRequest = {
  resource: string;
  action: string;
  rationale: string;
};

export class PermissionGate {
  async request(request: PermissionRequest): Promise<boolean> {
    if (typeof window === "undefined") return false;
    if (window.curator?.requestPermission) {
      return window.curator.requestPermission(request);
    }
    const message = `${request.rationale}\n\nAllow ${request.action} access to ${request.resource}?`;
    return window.confirm(message);
  }
}
