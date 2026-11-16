import { describe, expect, it } from 'vitest';

import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { teamSnapshotOf } from '../../teams/utils/team-snapshot';
import { reportedModelOf, usageDimensions } from './usage-dimensions';

const run = (overrides: Partial<Run> = {}): Run =>
  ({
    id: 'run-a',
    teamId: null,
    teamSnapshot: null,
    title: null,
    cwd: null,
    agentKind: null,
    model: null,
    ...overrides,
  }) as Run;

const node = (overrides: Partial<NodeState> = {}): NodeState =>
  ({
    runId: 'run-a',
    memberId: 'main',
    agentKind: null,
    model: null,
    ...overrides,
  }) as NodeState;

/** The copy a team run keeps, written by the executor's own writer. */
const snapshotNamed = (name: string): string =>
  teamSnapshotOf(teamOf([member('dev')], { name }));

describe('usageDimensions', () => {
  it('names the team from the run’s own snapshot, never its title', () => {
    // A team run is titled after its CONVERSATION now, like a chat. Read
    // from the title, one team's spend split into a row per task it was
    // ever run on — the breakdown named what each run was ABOUT.
    const dimensions = usageDimensions(
      run({
        teamId: 'nightly-review',
        title: 'Fix the flaky login test',
        teamSnapshot: snapshotNamed('Nightly review'),
      }),
      node({ agentKind: 'claude' }),
    );

    expect(dimensions.teamName).toBe('Nightly review');
  });

  it('files every run of one team under one name, however each is titled', () => {
    const snapshot = snapshotNamed('Nightly review');
    const names = [
      run({
        teamId: 'nightly-review',
        title: null,
        teamSnapshot: snapshot,
      }),
      run({
        teamId: 'nightly-review',
        title: 'Bump the SDK',
        teamSnapshot: snapshot,
      }),
    ].map((one) => usageDimensions(one, null).teamName);

    // The FIRST turns of a run land before the run is named, and must not
    // fall through to the slug — one team, two keys, within one run.
    expect(names).toEqual(['Nightly review', 'Nightly review']);
  });

  it('files a turn under the pool member its own row names over its member’s stamp', () => {
    // A pooled member is stamped with pool member 1; a call another member ran says so
    // on its usage rows, and its spend belongs to that CLI and that model.
    const member1 = {
      agentKind: 'claude',
      model: 'opus',
    } as unknown as NodeState;
    const dimensions = usageDimensions(run({ teamId: 'team' }), member1, null, {
      agentKind: AgentKind.Codex,
      model: 'gpt-5.5',
    });
    expect(dimensions).toMatchObject({ agentKind: 'codex', model: 'gpt-5.5' });
    // A member on its CLI's default model is filed under no model — never
    // under member 1's — unless the CLI reported the one it ran.
    expect(
      usageDimensions(run({ teamId: 'team' }), member1, null, {
        agentKind: AgentKind.Codex,
        model: null,
      }).model,
    ).toBeNull();
    expect(
      usageDimensions(run({ teamId: 'team' }), member1, 'gpt-5.6', {
        agentKind: AgentKind.Codex,
        model: null,
      }).model,
    ).toBe('gpt-5.6');
  });

  it('leaves a single-agent chat out of the team breakdown', () => {
    // A CHAT carries a title too — its conversation name. Taking the title
    // unconditionally files every chat in the team breakdown under its own
    // heading, which is the one thing that breakdown must not contain, so the
    // gate is `teamId` and never the title's presence.
    const dimensions = usageDimensions(
      run({ teamId: null, title: 'Fix the login bug' }),
      null,
    );

    expect(dimensions.teamName).toBeNull();
  });

  it('falls back to the slug when the run holds no snapshot — not to its title', () => {
    // A run made before snapshots existed carries none until something first
    // reads its team. The slug is the file name, which is still a thing a
    // person can recognise; the title would be the conversation's.
    const dimensions = usageDimensions(
      run({ teamId: 'nightly-review', title: 'Fix the login bug' }),
      null,
    );

    expect(dimensions.teamName).toBe('nightly-review');
  });

  it('falls back to the slug when the snapshot cannot be read', () => {
    const dimensions = usageDimensions(
      run({ teamId: 'nightly-review', teamSnapshot: 'not json {' }),
      null,
    );

    expect(dimensions.teamName).toBe('nightly-review');
  });

  it('prefers the MEMBER’s agent and model over the run’s', () => {
    // A team run names no single agent — its own `agentKind` is null and
    // each member names its own. Reading the run alone attributes every member's
    // spend to nothing.
    const dimensions = usageDimensions(
      run({ teamId: 'w', agentKind: null, model: null, cwd: '/work' }),
      node({ agentKind: 'cursor-agent', model: 'auto' }),
    );

    expect(dimensions.agentKind).toBe('cursor-agent');
    expect(dimensions.model).toBe('auto');
    // `cwd` only ever lives on the run — `node_state` stamps none.
    expect(dimensions.cwd).toBe('/work');
  });

  it('files a turn under the model the CLI REPORTED, over the one it was asked for', () => {
    // A run that leaves the choice to the CLI names no model, which filed real
    // spend under a "CLI default" row naming none; and an alias (`opus`) splits
    // one model across two rows.
    expect(
      usageDimensions(
        run({ model: null }),
        null,
        reportedModelOf({ usage: { contextModel: 'claude-opus-5-5' } }),
      ).model,
    ).toBe('claude-opus-5-5');
    expect(
      usageDimensions(run({ model: 'opus' }), null, 'claude-opus-5-5').model,
    ).toBe('claude-opus-5-5');
    // Nothing reported: the setting is all there is.
    expect(usageDimensions(run({ model: 'opus' }), null, null).model).toBe(
      'opus',
    );
  });

  it('reads no reported model from a payload that names none', () => {
    expect(reportedModelOf({ usage: { contextModel: '' } })).toBeNull();
    expect(reportedModelOf({ usage: {} })).toBeNull();
    expect(reportedModelOf(null)).toBeNull();
  });

  it('answers for a run that is already gone', () => {
    // The backfill sweeps transcript rows whose run may have been deleted. Every
    // dimension is then unknown, which must be null rather than a throw.
    expect(usageDimensions(null, null)).toEqual({
      agentKind: null,
      model: null,
      cwd: null,
      teamName: null,
      purpose: null,
    });
  });

  it('files a lessons reflection’s turns under the lessons purpose, and no other run’s', () => {
    expect(
      usageDimensions(run({ analysisPurpose: 'lessons' }), null).purpose,
    ).toBe('lessons');
    expect(
      usageDimensions(run({ analysisPurpose: 'review' }), null).purpose,
    ).toBeNull();
    expect(usageDimensions(run(), null).purpose).toBeNull();
  });
});
