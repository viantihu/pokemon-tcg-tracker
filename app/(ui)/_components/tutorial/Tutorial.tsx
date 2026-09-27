"use client";

/**
 * The first-run tutorial (UIL-128): a step card over the app, one step per part of it, each pointing at its nav
 * tab. It opens by itself on an account's first page load (the layout reads `onboarding`, 0031) and from
 * Settings' Replay. Finishing or skipping records it as done on the account, so it never opens by itself again.
 *
 * NOT MODAL. The card sits at the bottom and the page stays usable under it, so she can follow a step (open
 * Settings, add a binder) with the tour still open; the provider lives in the `(ui)` layout, so the tour keeps
 * its place across tabs. Escape skips it, through the shared escape layer, so a popup opened over it closes first.
 *
 * Recording it done is best effort. If that call fails, the tour still closes and simply opens again on her
 * next visit, which is the whole cost; nothing she did is lost, so nothing is said.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { LOST, isUnreached, reach } from "../reach";
import { useEscapeLayer } from "../escape-layer";
import { finishTutorial, loadTutorialNext } from "./actions";
import {
  TUTORIAL_BUTTONS,
  TUTORIAL_NEXT,
  TUTORIAL_STEPS,
  tutorialCounter,
  type TutorialNext,
} from "./steps";

interface TutorialContextValue {
  /** Open the tour at its first step (Settings' Replay). */
  open: () => void;
  /** The nav tabs the current step points at; empty while the tour is closed. */
  targets: readonly string[];
}

const TutorialContext = createContext<TutorialContextValue>({ open: () => {}, targets: [] });

/** The tour's controls, for the top bar and Settings. Outside the provider it is closed and cannot open. */
export function useTutorial(): TutorialContextValue {
  return useContext(TutorialContext);
}

export function TutorialProvider({
  startOpen,
  children,
}: {
  startOpen: boolean;
  children: ReactNode;
}) {
  const [step, setStep] = useState<number | null>(startOpen ? 0 : null);
  const [next, setNext] = useState<TutorialNext | null>(null);
  const router = useRouter();
  const isOpen = step !== null;

  const open = useCallback(() => {
    setStep(0);
    window.scrollTo({ top: 0 });
  }, []);

  // Read what her account needs first each time the tour opens, for the finish step's button.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void reach(() => loadTutorialNext(), LOST.read).then((res) => {
      if (live) setNext(isUnreached(res) ? null : res);
    });
    return () => {
      live = false;
    };
  }, [isOpen]);

  const close = useCallback(() => {
    setStep(null);
    void reach(() => finishTutorial(), LOST.action);
  }, []);

  const finish = useCallback(() => {
    close();
    if (next) router.push(TUTORIAL_NEXT[next].href);
  }, [close, next, router]);

  useEscapeLayer(isOpen, close);

  const value = useMemo<TutorialContextValue>(
    () => ({ open, targets: step === null ? [] : TUTORIAL_STEPS[step].targets }),
    [open, step],
  );

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {step !== null ? (
        <TutorialCard
          step={step}
          next={next}
          onBack={() => setStep(Math.max(0, step - 1))}
          onNext={() => setStep(Math.min(TUTORIAL_STEPS.length - 1, step + 1))}
          onSkip={close}
          onFinish={finish}
        />
      ) : null}
    </TutorialContext.Provider>
  );
}

export function TutorialCard(props: {
  step: number;
  next: TutorialNext | null;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const { step, next } = props;
  const s = TUTORIAL_STEPS[step];
  const last = step === TUTORIAL_STEPS.length - 1;
  const ref = useRef<HTMLDivElement>(null);

  // Each step takes focus, so a keyboard or screen-reader user hears the new step, not the old button.
  useEffect(() => {
    ref.current?.focus();
  }, [step]);

  return (
    <div
      ref={ref}
      className="tour panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      tabIndex={-1}
    >
      <div className="tour-count u">{tutorialCounter(step, TUTORIAL_STEPS.length)}</div>
      <b id="tour-title" className="tour-title u">
        {s.title}
      </b>
      <p id="tour-body" className="tour-body">
        {s.body}
      </p>
      {last && next ? <p className="tour-body tour-lead">{TUTORIAL_NEXT[next].lead}</p> : null}
      <div className="tour-actions">
        {step > 0 ? (
          <button type="button" className="btn u" onClick={props.onBack}>
            {TUTORIAL_BUTTONS.back}
          </button>
        ) : null}
        {!last ? (
          <button type="button" className="btn u" onClick={props.onSkip}>
            {TUTORIAL_BUTTONS.skip}
          </button>
        ) : null}
        {last ? (
          <button type="button" className="btn btn-primary u" onClick={props.onFinish}>
            {next ? TUTORIAL_NEXT[next].button : TUTORIAL_BUTTONS.done}
          </button>
        ) : (
          <button type="button" className="btn btn-primary u" onClick={props.onNext}>
            {TUTORIAL_BUTTONS.next}
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings' way back into the tour. */
export function ReplayTutorialButton() {
  const { open } = useTutorial();
  return (
    <button type="button" className="btn u" onClick={open}>
      {TUTORIAL_BUTTONS.replay}
    </button>
  );
}
