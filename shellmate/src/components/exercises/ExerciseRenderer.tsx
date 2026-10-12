import type { ExerciseProps, ExerciseType } from '../../types';
import { MultipleChoice } from './MultipleChoice';
import { TerminalExercise } from './TerminalExercise';
import { FillBlank } from './FillBlank';
import { OrderSteps } from './OrderSteps';
import { MatchPairs } from './MatchPairs';
import { SpotBadPrompt } from './SpotBadPrompt';
import { PromptWorkshop } from './PromptWorkshop';
import { Mission } from './Mission';

export function exerciseTitle(type: ExerciseType): string {
  switch (type) {
    case 'multiple-choice':
      return 'Select the correct answer';
    case 'terminal':
      return 'Type the command';
    case 'fill-blank':
      return 'Fill in the blanks';
    case 'order-steps':
      return 'Put the steps in order';
    case 'match-pairs':
      return 'Tap the matching pairs';
    case 'spot-bad-prompt':
      return 'Pick the better prompt';
    case 'prompt-workshop':
      return 'Write a prompt';
    case 'mission':
      return 'Real-world mission';
    default: {
      const never: never = type;
      return String(never);
    }
  }
}

export function ExerciseRenderer(props: ExerciseProps) {
  const { exercise, locked, onReady } = props;
  switch (exercise.type) {
    case 'multiple-choice':
      return <MultipleChoice key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'terminal':
      return <TerminalExercise key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'fill-blank':
      return <FillBlank key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'order-steps':
      return <OrderSteps key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'match-pairs':
      return <MatchPairs key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'spot-bad-prompt':
      return <SpotBadPrompt key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'prompt-workshop':
      return <PromptWorkshop key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    case 'mission':
      return <Mission key={exercise.id} exercise={exercise} locked={locked} onReady={onReady} />;
    default: {
      const never: never = exercise;
      throw new Error(`Unknown exercise type: ${JSON.stringify(never)}`);
    }
  }
}
