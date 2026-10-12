// Judgement, submission and scoring (T-301). Pure — no DOM / Three / worker.

export {
  judge,
  starsFor,
  JUDGE_MESSAGES,
  RULE_LABELS,
  type BenchmarkComparison,
  type BenchmarkRelation,
  type CaseVerdict,
  type Judgement,
  type Outcome,
  type RuleId,
  type RuleStatus,
  type RuleVerdict,
  type Stars,
} from './judge.ts';
export {
  submit,
  submitGate,
  SUBMIT_MESSAGES,
  type StageClear,
  type SubmitGate,
  type SubmitGateInput,
  type Submission,
  type SubmitSource,
} from './submit.ts';
