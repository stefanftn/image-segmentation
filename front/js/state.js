/**
 * state.js — the state machine from spec §2.
 *
 * The machine owns two things: which screen is visible, and the context that
 * screen needs. It writes the current state to `body[data-state]`; styles.css
 * does the showing and hiding. No other module touches visibility.
 *
 * Transitions are declared, not implied. An illegal transition is a bug in
 * the caller and says so loudly in the console rather than half-updating the
 * UI — which is how "spinner forever after a race" usually starts.
 *
 * `ready` has two faces — picking regions out of a label map, and editing a
 * surface that already exists — but they are not states. Nothing about the
 * flow differs between them: no request is in flight, no transition is
 * reachable from one and not the other, and a Regions session crosses between
 * them repeatedly without anything else changing. They are carried on
 * `body[data-ready]` by app.js instead, which keeps this machine describing
 * the shape of the work rather than the shape of the screen.
 */

export const STATE = Object.freeze({
  IDLE: "idle",
  UPLOADING: "uploading",
  // Was POLLING/"polling" — the wait is now push-based (SignalR), not a poll
  // loop, but the shape of the transitions is unchanged (§2.3 of the
  // migration notes). Renamed for clarity only.
  TRACKING: "tracking",
  READY: "ready",
  ERROR: "error",
});

/** Error is reachable from anywhere; everything else is a straight line. */
const TRANSITIONS = {
  [STATE.IDLE]:      [STATE.UPLOADING, STATE.ERROR],
  [STATE.UPLOADING]: [STATE.TRACKING, STATE.IDLE, STATE.ERROR],
  [STATE.TRACKING]:  [STATE.READY, STATE.IDLE, STATE.ERROR],
  [STATE.READY]:     [STATE.IDLE, STATE.UPLOADING, STATE.ERROR],
  [STATE.ERROR]:     [STATE.IDLE, STATE.UPLOADING, STATE.TRACKING, STATE.READY],
};

export function createMachine({ initial = STATE.IDLE, root = document.body } = {}) {
  let current = initial;
  let context = {};
  const listeners = new Set();

  function emit(previous) {
    for (const fn of listeners) {
      try {
        fn({ state: current, previous, context });
      } catch (err) {
        console.error("[state] listener threw", err);
      }
    }
  }

  function apply() {
    root.dataset.state = current;
  }

  apply();

  return {
    get state() { return current; },
    get context() { return context; },

    is(...states) { return states.includes(current); },

    /** Merge fields into context without changing state (e.g. a poll tick). */
    update(patch = {}) {
      context = { ...context, ...patch };
      emit(current);
      return context;
    },

    /**
     * @param {string} next
     * @param {object} patch  context fields for the new state
     * @returns {boolean} whether the transition was legal and applied
     */
    to(next, patch = {}) {
      if (next === current) {
        this.update(patch);
        return true;
      }
      if (!TRANSITIONS[current]?.includes(next)) {
        console.warn(`[state] refused ${current} → ${next}`);
        return false;
      }
      const previous = current;
      current = next;
      context = { ...context, ...patch };
      apply();
      emit(previous);
      return true;
    },

    /** Drop context entirely — used when starting a genuinely new job. */
    reset(patch = {}) {
      const previous = current;
      current = STATE.IDLE;
      context = { ...patch };
      apply();
      emit(previous);
    },

    subscribe(fn) {
      listeners.add(fn);
      fn({ state: current, previous: null, context });
      return () => listeners.delete(fn);
    },
  };
}
