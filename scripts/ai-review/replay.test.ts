import { replayModels } from './replay';
import { readConfig } from '../ai-pr-review';

describe('replayModels', () => {
  const prodEnv = {
    OPENAI_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghs-test',
    REPO: 'ysilvestrov/warsaw-beer-bot',
    PR_NUMBER: '1',
    BASE_REF: 'main',
  } as NodeJS.ProcessEnv;

  // Replay exists to measure the configuration CI actually runs. If the two
  // default sets drift apart it silently measures something else.
  it('defaults to exactly the models the production reviewer defaults to', () => {
    const prod = readConfig(prodEnv);
    expect(replayModels({} as NodeJS.ProcessEnv)).toEqual({
      findModel: prod.findModel,
      verifyModel: prod.verifyModel,
    });
  });

  it('honours the same env overrides as the production reviewer', () => {
    expect(
      replayModels({
        AI_REVIEW_MODEL: 'find-x',
        AI_REVIEW_VERIFY_MODEL: 'verify-y',
      } as NodeJS.ProcessEnv),
    ).toEqual({ findModel: 'find-x', verifyModel: 'verify-y' });
  });
});
