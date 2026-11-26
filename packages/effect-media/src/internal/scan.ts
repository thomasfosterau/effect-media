// Walks a byte stream whose next offset depends on what was just read, such as
// JPEG segments or PNG chunks. A loop rather than recursion, so that a file with
// many segments cannot overflow the stack.
import * as Option from "effect/Option";
import * as P from "effect/Predicate";

/**
 * Calls `step` from `start` until it returns an `Option`: a number is the
 * offset to continue from, and must move forward or the scan stops.
 */
export const scan = <A>(
  start: number,
  step: (at: number) => number | Option.Option<A>,
): Option.Option<A> => {
  let at = start;
  for (;;) {
    const next = step(at);
    if (!P.isNumber(next)) {
      return next;
    }
    if (next <= at) {
      return Option.none();
    }
    at = next;
  }
};
