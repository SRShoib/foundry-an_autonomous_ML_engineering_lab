/** Names for the generated schema types, so components never write `components["schemas"][...]`
 * inline. Every type here is DERIVED from src/api/schema.d.ts (generated from the FastAPI app's
 * OpenAPI schema), never declared by hand: CLAUDE.md's "types generated from FastAPI OpenAPI,
 * never hand-written". The only hand-written pieces are the two `kind` discriminants on the JSONL
 * line shapes, which name a file format, not an API type.
 */
import type { components } from "./schema";

type Schemas = components["schemas"];

export type RunStatus = Schemas["RunStatus"];
export type PendingApproval = Schemas["PendingApproval"];
export type ActivityEvent = Schemas["ActivityEvent"];
export type ExperimentResult = Schemas["ExperimentResult"];
export type AttemptRecord = Schemas["AttemptRecord"];
export type RedTeamFinding = Schemas["RedTeamFinding"];
export type AuditEvidence = Schemas["AuditEvidence"];
export type PendingSpecCost = Schemas["PendingSpecCost"];
export type DataProfile = Schemas["DataProfile"];
export type LeaderboardEntry = Schemas["LeaderboardEntry"];
export type TaskResult = Schemas["TaskResult"];

export type Replay = Schemas["Replay"];
export type ReplayFrame = Schemas["ReplayFrame"];
export type ReplayHeader = Schemas["ReplayHeader"];
export type ReplayDecision = Schemas["ReplayDecision"];
export type ReplaySummary = Schemas["ReplaySummary"];

export type StartRunRequest = Schemas["StartRunRequest"];
export type StartRunResponse = Schemas["StartRunResponse"];
export type ResumeRequest = Schemas["ResumeRequest"];

export type RunStatusKind = RunStatus["status"];
export type ApprovalGate = PendingApproval["gate"];
export type EventKind = ActivityEvent["kind"];
export type RedTeamCategory = RedTeamFinding["category"];
export type AttemptOutcome = AttemptRecord["outcome"];

/** One line of a replay .jsonl file (app/replay.py's replay_to_jsonl): the header first, then one
 * frame per line, each tagged with `kind`. */
export type ReplayHeaderLine = ReplayHeader & { kind: "header" };
export type ReplayFrameLine = ReplayFrame & { kind: "frame" };
export type ReplayLine = ReplayHeaderLine | ReplayFrameLine;
