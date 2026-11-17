import { toolInputSchema } from '../tool-args';
import { ArtifactAnswersArgsSchema } from './artifact-answers.reader';

/** `artifact_answers`' arguments, generated from the schema the reader holds them to. */
export function artifactAnswersSchema(): Record<string, unknown> {
  return toolInputSchema(
    ArtifactAnswersArgsSchema.extend({
      artifact_id: ArtifactAnswersArgsSchema.shape.artifact_id.describe(
        'The page to read, by the artifact_id show_artifact named. Leave it out to read every page of this run that has answers.',
      ),
    }),
  );
}
