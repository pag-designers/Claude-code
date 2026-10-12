// Shared, typed contract for content, exercises and progress.
// Adding a new exercise type = add a member to the `Exercise` union,
// a component in components/exercises/, and a case in ExerciseRenderer.

export type TheoryCard = {
  title: string;
  /** Markdown-lite: paragraphs separated by blank lines, `inline code` with backticks, **bold**. */
  body: string;
  /** Optional code/terminal example rendered in a mono block. */
  code?: string;
};

type Base = {
  id: string;
  /** Shown after answering (green/red sheet). One sentence. */
  explanation: string;
};

export type MultipleChoiceExercise = Base & {
  type: 'multiple-choice';
  prompt: string;
  /** Exactly 4 options. */
  options: string[];
  answer: number; // index into options
};

export type TerminalExercise = Base & {
  type: 'terminal';
  /** Task description, e.g. "Start a session that continues your last conversation". */
  prompt: string;
  /** Text shown before the cursor. Default "$". Use ">" for in-session slash commands. */
  promptSymbol?: string;
  /** All accepted answers. Grading normalizes whitespace, flag order, and quotes. */
  accepted: string[];
  /** Optional hint shown on demand. */
  hint?: string;
};

export type FillBlankExercise = Base & {
  type: 'fill-blank';
  prompt: string;
  /** Code snippet; each blank is written as `___` (three underscores). */
  code: string;
  /** Correct word for each blank, in order. */
  blanks: string[];
  /** Chips the user can tap: must include all `blanks` plus distractors. */
  wordBank: string[];
  /** For display only: 'json' | 'markdown' | 'bash' | ... */
  language?: string;
};

export type OrderStepsExercise = Base & {
  type: 'order-steps';
  prompt: string;
  /** Steps in the CORRECT order; UI shuffles them. */
  steps: string[];
};

export type MatchPairsExercise = Base & {
  type: 'match-pairs';
  prompt: string;
  /** 3–5 pairs. left is usually a command, right is what it does. */
  pairs: { left: string; right: string }[];
};

export type SpotBadPromptExercise = Base & {
  type: 'spot-bad-prompt';
  /** Scenario, e.g. "You want Claude to fix a failing test." */
  prompt: string;
  /** Two prompts; `better` is the index of the better one. */
  options: [string, string];
  better: 0 | 1;
};

export type PromptWorkshopExercise = Base & {
  type: 'prompt-workshop';
  /** Scenario the user writes a prompt for. */
  scenario: string;
  /** Optional files the user could reference with @ (e.g. "src/auth/login.ts"). */
  files?: string[];
  /** Example of a great answer, shown after grading. */
  sample: string;
  /** Extra domain keywords that count as "specific goal" (e.g. ["login", "timeout"]). */
  keywords?: string[];
};

export type MissionExercise = Base & {
  type: 'mission';
  title: string;
  intro: string;
  /** Checklist items to do in a real terminal. */
  checklist: string[];
  bonusXp: number;
  /** Badge id awarded on completion (see content/badges.json). */
  badge?: string;
};

export type Exercise =
  | MultipleChoiceExercise
  | TerminalExercise
  | FillBlankExercise
  | OrderStepsExercise
  | MatchPairsExercise
  | SpotBadPromptExercise
  | PromptWorkshopExercise
  | MissionExercise;

export type ExerciseType = Exercise['type'];

export type Lesson = {
  id: string; // globally unique, e.g. "u1-l1"
  title: string;
  /** Short subtitle on the path tooltip. */
  description: string;
  theory: TheoryCard[]; // 1–2
  exercises: Exercise[]; // 6–10
};

export type CheatItem = {
  /** The command, shortcut or concept, e.g. "claude --continue" or "Shift+Tab". */
  term: string;
  description: string;
  kind: 'command' | 'slash' | 'shortcut' | 'flag' | 'concept' | 'file';
};

export type Unit = {
  id: string; // "u1"
  order: number; // 1..12
  title: string;
  description: string;
  /** Hex color for nodes and banner. */
  color: string;
  lessons: Lesson[];
  /** Real-world mission shown as the final node of the unit. */
  mission: MissionExercise;
  /** Cheat-sheet entries unlocked when the unit's first lesson is completed. */
  cheatsheet: CheatItem[];
};

export type Badge = {
  id: string;
  name: string;
  description: string;
  emoji: string;
};

// ---------- Progress / grading ----------

export type GradeResult = {
  correct: boolean;
  /** Optional feedback override (e.g. prompt workshop rubric). */
  feedback?: string;
  /** 1–3 for prompt workshop. */
  stars?: number;
};

/** Props every exercise component receives. */
export type ExerciseProps<E extends Exercise = Exercise> = {
  exercise: E;
  /** True after "Check" was pressed; component must lock input and show correct/incorrect state. */
  locked: boolean;
  /** Report whether the user has given enough input to press Check, plus a grader to call on Check. */
  onReady: (ready: boolean, grade?: () => GradeResult) => void;
};

export type DailyGoal = 20 | 50 | 100;
export type Experience = 'new' | 'some' | 'dev';
