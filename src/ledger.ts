// Minimal Canton JSON Ledger API v2 client — plain Node fetch, zero deps.
//
// Canton 3.x participants expose the Ledger API over HTTP/JSON ("JSON API
// v2", `daml sandbox --json-api-port`). For the executor's needs — allocate
// parties, read the ACS, submit-and-wait — this is a handful of endpoints,
// which keeps the tool dependency-free (no @grpc/grpc-js, no protobuf).
// The gRPC API stays an option later behind the same LedgerApi interface.
//
// Endpoint shapes verified against a live sandbox (SDK 3.4.11); if a field
// name drifts in a future SDK, the probe script in test/ is the fast check.

export interface ActiveContract {
  contractId: string;
  templateId: string;
  /** The create argument as Daml-JSON (numerics are strings). */
  payload: Record<string, unknown>;
}

export type LedgerCommand =
  | { CreateCommand: { templateId: string; createArguments: unknown } }
  | {
      ExerciseCommand: {
        templateId: string;
        contractId: string;
        choice: string;
        choiceArgument: unknown;
      };
    };

export type SubmitResult =
  | { ok: true; updateId: string }
  | { ok: false; error: string };

/** What the executor needs from a ledger — implemented by LedgerClient and
 * by the in-memory fake in tests. */
export interface LedgerApi {
  allocateParty(hint: string): Promise<string>;
  /** Live contracts of one template — or, with kind "interface", of every
   * template implementing one interface — visible to `parties`, sorted by
   * contractId so an index is stable within a run. */
  activeContracts(
    parties: string[],
    templateId: string,
    kind?: "template" | "interface",
  ): Promise<ActiveContract[]>;
  submitAndWait(req: {
    commands: LedgerCommand[];
    commandId: string;
    actAs: string[];
  }): Promise<SubmitResult>;
}

export class HttpJsonLedgerError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  constructor(path: string, status: number, body: string) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/** Pull the human-meaningful message out of a JsCantonError body, falling
 * back to the raw text. */
export function cantonErrorCause(body: string): string {
  try {
    const j = JSON.parse(body) as { cause?: string; code?: string };
    if (j.cause) return j.code ? `${j.code}: ${j.cause}` : j.cause;
  } catch {
    /* not JSON — fall through */
  }
  return body.slice(0, 400);
}

export class LedgerClient implements LedgerApi {
  private readonly base: string;
  private readonly userId: string;
  constructor(base: string, userId = "ledger-api-user") {
    this.base = base;
    this.userId = userId;
  }

  private async req(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpJsonLedgerError(path, res.status, text);
    return text ? JSON.parse(text) : null;
  }

  async ledgerEnd(): Promise<number> {
    const r = (await this.req("GET", "/v2/state/ledger-end")) as { offset: number };
    return r.offset;
  }

  async allocateParty(hint: string): Promise<string> {
    const r = (await this.req("POST", "/v2/parties", {
      partyIdHint: hint,
      identityProviderId: "",
    })) as { partyDetails: { party: string } };
    return r.partyDetails.party;
  }

  async activeContracts(
    parties: string[],
    templateId: string,
    kind: "template" | "interface" = "template",
  ): Promise<ActiveContract[]> {
    const activeAtOffset = await this.ledgerEnd();
    const identifierFilter =
      kind === "interface"
        ? {
            InterfaceFilter: {
              value: {
                interfaceId: templateId,
                // The view is the payload fallback: for standard interfaces
                // (Holding) it carries the owner an { ownerOf } arg needs.
                includeInterfaceView: true,
                includeCreatedEventBlob: false,
              },
            },
          }
        : { TemplateFilter: { value: { templateId, includeCreatedEventBlob: false } } };
    const filters = { cumulative: [{ identifierFilter }] };
    const r = (await this.req("POST", "/v2/state/active-contracts", {
      filter: { filtersByParty: Object.fromEntries(parties.map((p) => [p, filters])) },
      verbose: true,
      activeAtOffset,
    })) as Array<{
      contractEntry?: {
        JsActiveContract?: {
          createdEvent?: {
            contractId: string;
            templateId: string;
            createArgument?: Record<string, unknown>;
            interfaceViews?: Array<{ viewValue?: Record<string, unknown> }>;
          };
        };
      };
    }>;
    const out: ActiveContract[] = [];
    for (const entry of r) {
      const ev = entry.contractEntry?.JsActiveContract?.createdEvent;
      if (ev)
        out.push({
          contractId: ev.contractId,
          templateId: ev.templateId,
          // Interface-filtered events may omit the create argument; the
          // interface view is the fallback.
          payload: ev.createArgument ?? ev.interfaceViews?.[0]?.viewValue ?? {},
        });
    }
    out.sort((a, b) => (a.contractId < b.contractId ? -1 : 1));
    return out;
  }

  async submitAndWait(req: {
    commands: LedgerCommand[];
    commandId: string;
    actAs: string[];
  }): Promise<SubmitResult> {
    try {
      const r = (await this.req("POST", "/v2/commands/submit-and-wait", {
        commands: req.commands,
        commandId: req.commandId,
        actAs: req.actAs,
        readAs: [],
        userId: this.userId,
      })) as { updateId: string };
      return { ok: true, updateId: r.updateId };
    } catch (e) {
      // Command rejections come back as HTTP errors with a JsCantonError
      // body — those are fuzzing DATA, not client failures.
      if (e instanceof HttpJsonLedgerError)
        return { ok: false, error: cantonErrorCause(e.body) };
      throw e;
    }
  }
}
