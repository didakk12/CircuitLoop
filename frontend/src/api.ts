/**
 * Typed client for the CircuitLoop TypeScript backend. The frontend talks
 * only to this backend — never directly to the Python ML service — per
 * ML_SERVICE_INTEGRATION_PLAN.md's explicit architecture: the backend is
 * the sole orchestrator, the frontend is just its client.
 *
 * Field names are snake_case, matching the backend's actual wire contract
 * (`backend/src/types/dto.ts`) exactly — not reshaped here, since this
 * project's convention (already established between the TS backend and
 * the Python ML service) is to mirror the producing side's contract
 * verbatim rather than transform it at each hop.
 */

/**
 * Empty by default: requests go to the same origin and the Vite dev server
 * proxies /api to the backend (see vite.config.ts).
 *
 * Same-origin is a requirement of the httpOnly session cookie, not a
 * preference — a cross-site request would not carry a SameSite=Lax cookie.
 * Override only for a deployment that genuinely serves the API elsewhere and
 * has the CORS/cookie configuration to match.
 */
const API_BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export type ComponentType =
  | "resistor"
  | "capacitor"
  | "led"
  | "diode"
  | "transistor"
  | "ic"
  | "microcontroller"
  | "battery"
  | "buzzer"
  | "display"
  | "relay"
  | "switch"
  | "unknown";

export type ComponentCondition = "good" | "damaged" | "uncertain" | "unknown";
export type SalvagePriority = "high" | "medium" | "low";
export type ComponentStatus = "not_tested" | "pass" | "fail";

export interface ApiTestResult {
  id: string;
  component_id: string;
  expected_value: number | null;
  measured_value: number | null;
  unit: string | null;
  status: ComponentStatus;
  timestamp: string;
}

export interface ApiComponent {
  id: string;
  scan_id: string | null;
  type: ComponentType;
  /**
   * The detector's own name for the component — "network switch",
   * "potentiometer", "ic". Null for components detected before the backend
   * stored it, so always render it as `label ?? type` (see
   * `componentIdentity` below), never on its own.
   */
  label: string | null;
  /**
   * The MARKING printed on the part: part number, brand, value — "74HC83",
   * "CISCO SG300-52 …". This is evidence about the component, NOT its
   * identity, and must never be displayed in place of `label`/`type`.
   */
  name: string | null;
  confidence: number;
  condition: ComponentCondition;
  salvage_priority: SalvagePriority | null;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  status: ComponentStatus;
  created_at: string;
  test_results: ApiTestResult[];
}

/**
 * What a component IS, for display — its detected label, falling back to the
 * normalised type when the label predates the field or was never set.
 *
 * The single rule, shared by every screen, so no view can drift back to
 * showing the printed marking (`name`) as the component's identity. `name`
 * belongs next to it as markings, never instead of it.
 */
export function componentIdentity(component: Pick<ApiComponent, "label" | "type">): string {
  const label = component.label?.trim();
  return label && label.length > 0 ? label : component.type;
}

export interface ApiScan {
  id: string;
  /** URL of this scan's stored image, or null if none. Points at the backend's ownership-checked endpoint — never a filesystem path. */
  image_url: string | null;
  timestamp: string;
  total_components: number;
  components: ApiComponent[];
}

/**
 * One prior turn replayed to the assistant so follow-up questions resolve.
 * Only these two roles exist — the backend rejects anything else, and the
 * system prompt is assembled server-side.
 */
export interface ApiConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Most recent turns the client sends. The backend independently validates and
 * re-trims (it never trusts this), but capping here keeps the request small
 * and matches what the server will actually use.
 */
export const ASSISTANT_HISTORY_LIMIT = 10;

/**
 * Trims a thread to the turns worth replaying: drops empty placeholders (the
 * in-flight assistant bubble has no content yet) and keeps only the most
 * recent exchanges.
 */
export function toConversationHistory(
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): ApiConversationMessage[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((message) => ({ role: message.role, content: message.content }));
}

export interface ApiAssistantResponse {
  component_id: string;
  /** True only once a real LLM provider is configured backend-side. */
  configured: boolean;
  message: string;
}

/** One frame from `POST /api/assistant/stream` (mirrors the backend's `AssistantStreamEvent`). */
export type ApiAssistantStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; configured: true }
  | { type: "unavailable"; text: string };

export interface AssistantStreamHandlers {
  /** A fragment of the answer arrived — append it. */
  onDelta: (text: string) => void;
  /** Generation finished normally. */
  onDone: (configured: boolean) => void;
  /**
   * No provider is configured, or generation failed. `text` is the generic
   * message and should *replace* anything streamed so far.
   */
  onUnavailable: (text: string) => void;
}

export interface ApiDashboardStats {
  total_scans: number;
  total_components: number;
  tested_components: number;
  passed_components: number;
  failed_components: number;
  not_tested_components: number;
  average_ai_confidence: number | null;
}

/** Thrown for any non-2xx response; `message` is the backend's own `{"detail": ...}` when available. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      // Required for the browser to send and store the httpOnly session
      // cookie. Without it every authenticated request is anonymous.
      credentials: "include",
    });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? `Could not reach the server: ${error.message}` : "Could not reach the server");
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detailValue =
      body !== null && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : undefined;
    const detail = typeof detailValue === "string" ? detailValue : `Request failed with status ${response.status}`;
    throw new ApiError(response.status, detail);
  }

  return response.json() as Promise<T>;
}

/** POST /api/scans — creates an empty scan to attach detections to. */
export function createScan(): Promise<ApiScan> {
  return request<ApiScan>("/api/scans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

/** GET /api/scans — the signed-in user's scan history, newest first. Summaries only (no nested components). */
export function getScans(): Promise<ApiScan[]> {
  return request<ApiScan[]>("/api/scans");
}

/** GET /api/scans/:id — full detail, components + their test results nested. */
export function getScan(id: string): Promise<ApiScan> {
  return request<ApiScan>(`/api/scans/${id}`);
}

/**
 * POST /api/scans/:id/upload — the actual detection call. The backend
 * forwards the image to the Python ML service, maps its raw detections to
 * the domain ComponentType, and persists them — this client only has to
 * send the file.
 */
export function uploadAndDetect(scanId: string, file: File, confidence?: number): Promise<ApiComponent[]> {
  const formData = new FormData();
  formData.append("image", file);
  if (confidence !== undefined) {
    formData.append("confidence", String(confidence));
  }
  return request<ApiComponent[]>(`/api/scans/${scanId}/upload`, {
    method: "POST",
    body: formData,
  });
}

/** GET /api/components — every stored component. Note: list responses don't include nested test_results (see backend/src/repositories/componentRepository.ts); use getLatestTestResult per-component for that. */
export function getComponents(): Promise<ApiComponent[]> {
  return request<ApiComponent[]>("/api/components");
}

/**
 * GET /api/components/:id/test-result — the latest recorded test result.
 * A 404 here legitimately means "no test recorded yet" (the backend's own
 * documented distinction, see backend/src/services/testResultService.ts),
 * not an error — resolves to `null` in that case instead of throwing.
 */
export async function getLatestTestResult(componentId: string): Promise<ApiTestResult | null> {
  try {
    return await request<ApiTestResult>(`/api/components/${componentId}/test-result`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
export interface CreateTestResultInput {
  expected_value?: number | null;
  measured_value?: number | null;
  unit?: string | null;
  status: ComponentStatus;
}

/** POST /api/components/:id/test — records a component test result. */
export function createTestResult(
  componentId: string,
  input: CreateTestResultInput,
): Promise<ApiTestResult> {
  return request<ApiTestResult>(`/api/components/${componentId}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** GET /api/dashboard/stats */
export function getDashboardStats(): Promise<ApiDashboardStats> {
  return request<ApiDashboardStats>("/api/dashboard/stats");
}

/**
 * POST /api/assistant — retrieval-backed answer about a specific
 * component. `configured: false` in the response means no LLM provider is
 * set up yet backend-side (Phase 6's documented, honest fallback state) —
 * `message` is still real, retrieval-based content, never a fake answer.
 */
export function askAssistant(
  componentId: string,
  question: string,
  history: ApiConversationMessage[] = [],
): Promise<ApiAssistantResponse> {
  return request<ApiAssistantResponse>("/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ component_id: componentId, question, history }),
  });
}

/**
 * POST /api/assistant/stream — same answer as `askAssistant`, delivered as
 * Server-Sent Events so it can be rendered as it is generated. Resolves when
 * the stream ends; rejects (with `ApiError`) only on a pre-stream failure
 * such as a 404 for an unknown component or a 400 for an empty question — a
 * provider failure mid-answer arrives as an `onUnavailable` call, not a
 * rejection, mirroring the non-streaming endpoint.
 */
export async function streamAssistant(
  componentId: string,
  question: string,
  handlers: AssistantStreamHandlers,
  signal?: AbortSignal,
  history: ApiConversationMessage[] = [],
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/assistant/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ component_id: componentId, question, history }),
      credentials: "include",
      signal,
    });
  } catch (error) {
    throw new ApiError(
      0,
      error instanceof Error ? `Could not reach the server: ${error.message}` : "Could not reach the server",
    );
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detailValue =
      body !== null && typeof body === "object" && "detail" in body ? (body as { detail: unknown }).detail : undefined;
    const detail = typeof detailValue === "string" ? detailValue : `Request failed with status ${response.status}`;
    throw new ApiError(response.status, detail);
  }
  if (!response.body) {
    throw new ApiError(0, "The server did not return a readable stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleFrame = (frame: string): void => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      return;
    }
    const payload = dataLine.slice("data:".length).trim();
    if (!payload) {
      return;
    }
    let event: ApiAssistantStreamEvent;
    try {
      event = JSON.parse(payload) as ApiAssistantStreamEvent;
    } catch {
      return;
    }
    if (event.type === "delta") {
      handlers.onDelta(event.text);
    } else if (event.type === "done") {
      handlers.onDone(event.configured);
    } else if (event.type === "unavailable") {
      handlers.onUnavailable(event.text);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      handleFrame(frame);
    }
  }
  if (buffer.trim()) {
    handleFrame(buffer);
  }
}

// --- Authentication -------------------------------------------------------

export interface ApiUser {
  id: string;
  email: string;
  created_at: string;
}

export function register(email: string, password: string): Promise<ApiUser> {
  return request<ApiUser>("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export function login(email: string, password: string): Promise<ApiUser> {
  return request<ApiUser>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
}

/**
 * The current session's user, or null if not signed in.
 *
 * A 401 is the expected answer for a signed-out visitor, so it resolves to
 * null rather than throwing — only genuine failures propagate.
 */
export async function getCurrentUser(): Promise<ApiUser | null> {
  try {
    return await request<ApiUser>("/api/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}
// --- Marketplace ----------------------------------------------------------

/**
 * Listing lifecycle, mirroring the backend's `MarketplaceListingStatus`.
 *
 * `ready_for_manual_post` is NOT published: the default `manual_assist`
 * provider posts nothing and just hands back a create-listing link, so the
 * listing stays fully editable. Only `published` freezes it.
 */
export type MarketplaceListingStatus = "draft" | "ready_for_manual_post" | "published" | "failed";

export interface ApiMarketplaceListing {
  id: string;
  component_id: string;
  /** Registry name of the provider this listing targets, e.g. "manual_assist". */
  provider: string;
  status: MarketplaceListingStatus;
  title: string;
  description: string;
  category: string;
  price_estimate: number;
  currency: string;
  /** Points at the ownership-checked `/api/scans/:id/image` endpoint, or null. Stable across component re-parenting. */
  image_url: string | null;
  /** The upstream listing, or the link to finish posting by hand. Null until publish is attempted. */
  external_url: string | null;
  external_listing_id: string | null;
  /** Why the last publish attempt failed. Null unless `status` is "failed". */
  error_message: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

/** Fields a listing owner may edit before it is published. All optional — a patch may change just the price. */
export interface UpdateMarketplaceListingInput {
  title?: string;
  description?: string;
  category?: string;
  price_estimate?: number;
  currency?: string;
}

/**
 * POST /api/marketplace/listings — creates a draft for a component, or returns
 * the component's existing active draft if it already has one.
 *
 * The backend answers 201 for a new draft and 200 for a reused one; both are
 * successes and both resolve here, so callers never have to care. Rejects with
 * a 404 `ApiError` for a component that isn't the signed-in user's.
 */
export function createMarketplaceDraft(componentId: string): Promise<ApiMarketplaceListing> {
  return request<ApiMarketplaceListing>("/api/marketplace/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ component_id: componentId }),
  });
}

/** GET /api/marketplace/listings/:id */
export function getMarketplaceListing(id: string): Promise<ApiMarketplaceListing> {
  return request<ApiMarketplaceListing>(`/api/marketplace/listings/${id}`);
}

/** GET /api/marketplace/listings?component_id=X — the component's full listing history, oldest first. */
export function listMarketplaceListingsForComponent(componentId: string): Promise<ApiMarketplaceListing[]> {
  return request<ApiMarketplaceListing[]>(
    `/api/marketplace/listings?component_id=${encodeURIComponent(componentId)}`,
  );
}

/**
 * PATCH /api/marketplace/listings/:id — partial update; omitted fields keep
 * their current values.
 *
 * Rejects with a 409 `ApiError` once the listing is `published`: at that point
 * it is a record of what was actually posted, and editing it would make it
 * describe an item nobody advertised.
 */
export function updateMarketplaceListing(
  id: string,
  input: UpdateMarketplaceListingInput,
): Promise<ApiMarketplaceListing> {
  return request<ApiMarketplaceListing>(`/api/marketplace/listings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * POST /api/marketplace/listings/:id/publish — hands the listing to its
 * configured provider.
 *
 * A provider failure or timeout is NOT a rejection: the backend records it as
 * `status: "failed"` with `error_message` set and still answers 200, so the
 * user's draft survives an upstream outage. Check `status` on the resolved
 * listing rather than relying on catch. Only ownership (404) and transport
 * failures reject.
 */
export function publishMarketplaceListing(id: string): Promise<ApiMarketplaceListing> {
  return request<ApiMarketplaceListing>(`/api/marketplace/listings/${id}/publish`, {
    method: "POST",
  });
}

// --- Telemetry ------------------------------------------------------------

export interface TelemetryMemory {
total_gb: number;
used_mb: number;
free_mb: number;
used_percent: number;
standby_mb: number;
modified_mb: number;
hard_faults_per_sec: number;
}

export interface TelemetryProcess {
pid: number;
name: string;
working_set_mb: number;
commit_mb: number;
}

export interface ApiTelemetryResponse {
telemetry: {
agent_id: string;
timestamp: string;
system_metrics: {
memory: TelemetryMemory;
};
top_processes: TelemetryProcess[];
};
response: {
status: "NORMAL" | "ACTION_REQUIRED";
action_id?: string;
target_pid?: number;
};
received_at: string;
}

/** GET /api/v1/telemetry — latest telemetry received from the Windows agent. */
export async function getTelemetry(): Promise<ApiTelemetryResponse | null> {
try {
return await request<ApiTelemetryResponse>("/api/v1/telemetry");
} catch (error) {
if (error instanceof ApiError && error.status === 404) {
return null;
}


throw error;

}
}
