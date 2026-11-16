import { isAnalysisRun } from '../../agents/utils/analysed-runs';
import type { Run } from '../../runs/entity/run.entity';

/** Whether a run may be reflected on: never an analysis, a team builder or a project chat. */
export function isReflectable(
  run: Pick<
    Run,
    | 'analysisSourceRunId'
    | 'analysisTeamSlug'
    | 'editsTeamSlug'
    | 'editsProjectId'
  >,
): boolean {
  return (
    !isAnalysisRun(run) &&
    run.editsTeamSlug === null &&
    run.editsProjectId === null
  );
}
