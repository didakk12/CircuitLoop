/**
 * How a line arriving from the board is matched to the command that is
 * waiting for it.
 *
 * This exists as its own abstraction for one specific reason. The firmware
 * today answers with a single unstructured line carrying no command id, so
 * the only correlation available is positional: whatever comes back next
 * belongs to whatever was just sent. That is *correct* today only because
 * `hardwareService` enforces a single in-flight command — but it is a
 * property of the current protocol, not of the design, and the moment
 * firmware gains request ids the matching rule changes completely.
 *
 * Inlining "the next line is the answer" into the state machine would bake
 * that assumption into control flow that has nothing to do with parsing.
 * Behind this interface, upgrading the protocol is swapping which
 * correlator is constructed — {@link TaggedAckCorrelator} below already
 * implements the tagged version and is unit-tested, so the abstraction is
 * demonstrated rather than merely asserted.
 */

/** One line from the board, plus the command id parsed out of it if the protocol carries one. */
export interface ParsedLine {
  commandId: string | null;
  raw: string;
}

export interface AckCorrelator {
  /** Told about every command as it goes out, so a stateful correlator can track what is outstanding. */
  onCommandSent(commandId: string, action: string): void;
  /** Parses one received line. Must not throw — a malformed line is still a line. */
  parseLine(line: string): ParsedLine;
  /** Whether `parsed` is the answer to `pendingCommandId`. */
  matchesPending(parsed: ParsedLine, pendingCommandId: string): boolean;
}

/**
 * The correlator wired in today: positional matching for a protocol with no
 * request ids.
 *
 * `matchesPending` returning true unconditionally is safe *only* under
 * `hardwareService`'s single-in-flight invariant — with at most one
 * outstanding command there is exactly one candidate a reply could belong
 * to, so there is nothing to disambiguate. If that invariant were ever
 * relaxed without also swapping in a correlator that reads real ids,
 * replies would be attributed to the wrong commands.
 */
export class SimpleAckCorrelator implements AckCorrelator {
  onCommandSent(_commandId: string, _action: string): void {
    // Nothing to remember: positional matching needs no state, because the
    // state machine's own PROBING state is what makes the match unambiguous.
  }

  parseLine(line: string): ParsedLine {
    return { commandId: null, raw: line };
  }

  matchesPending(_parsed: ParsedLine, _pendingCommandId: string): boolean {
    return true;
  }
}

/**
 * Correlator for a future firmware protocol that tags every exchange with
 * the command's id: the backend writes `CMD:<id>:<ACTION>` and the board
 * answers `ACK:<id>` (optionally `ACK:<id>:<detail>`).
 *
 * Implemented and tested but deliberately **not wired in**, because the
 * firmware does not speak this yet and pretending otherwise would break
 * every real board. It is here to prove the interface is sufficient: with
 * ids on the wire, a reply is matched by identity rather than by arrival
 * order, so the single-in-flight restriction becomes a policy choice instead
 * of a correctness requirement — and swapping to it is a construction
 * change in `hardwareService`, with no other code touched.
 */
export class TaggedAckCorrelator implements AckCorrelator {
  /** Wire format for an outgoing command under the tagged protocol. */
  static formatCommand(commandId: string, action: string): string {
    return `CMD:${commandId}:${action}`;
  }

  onCommandSent(_commandId: string, _action: string): void {
    // Also stateless: the id is carried on the wire in both directions, so
    // there is nothing to correlate against locally.
  }

  parseLine(line: string): ParsedLine {
    const trimmed = line.trim();
    // `ACK:<id>` or `ACK:<id>:<detail>` — the detail may itself contain
    // colons, so only the first two segments are structural.
    const match = /^ACK:([^:]+)(?::(.*))?$/.exec(trimmed);
    const id = match?.[1];
    if (id === undefined || id.length === 0) {
      // Not a tagged frame — boot banners and debug output still arrive on
      // the same wire. Surfaced as an untagged line rather than dropped, so
      // the caller can decide (and so `parseLine` keeps its no-throw
      // contract).
      return { commandId: null, raw: trimmed };
    }
    return { commandId: id, raw: trimmed };
  }

  matchesPending(parsed: ParsedLine, pendingCommandId: string): boolean {
    // An untagged line under the tagged protocol matches nothing: it is
    // board chatter, not an answer. This is exactly the case
    // SimpleAckCorrelator cannot distinguish.
    return parsed.commandId !== null && parsed.commandId === pendingCommandId;
  }
}
