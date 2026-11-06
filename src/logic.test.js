import { describe, expect, test } from 'vitest';
import { buttonState, courtQueue, courtSlots, justCalledUp, myPlace, openSpots, queueRows, spotsLabel, validSelection, waitingLabel } from './logic.js';

const names = { me: 'Alex', maya: 'Maya', jon: 'Jon', priya: 'Priya', sam: 'Sam', ava: 'Ava', leo: 'Leo', noor: 'Noor', kai: 'Kai' };
const e = (id, members, queueCourt = null) => ({ id, members, queueCourt, streak: 0 });

/** Court 1 full (Maya & Jon vs Priya & Sam), Court 2 has Kai alone; queues per court. */
function state(overrides = {}) {
  return {
    me: { id: 'me', name: 'Alex', isAdmin: false },
    names,
    courts: [
      { a: [e('c1a', ['maya', 'jon'], 0)], b: [e('c1b', ['priya', 'sam'], 0)] },
      { a: [e('c2a', ['kai'], 1)], b: [] },
    ],
    courtModes: ['doubles', 'doubles'],
    queue: [e('q1', ['ava', 'leo'], 0), e('q2', ['noor'], 0)],
    winCap: 3,
    ...overrides,
  };
}

describe('court queues', () => {
  test('each court lists only its own queue, plus legacy any-court entries', () => {
    const S = state({ queue: [e('q1', ['ava'], 0), e('q2', ['noor'], 1), e('q3', ['leo'], null)] });
    expect(courtQueue(S, 0).map(x => x.id)).toEqual(['q1', 'q3']);
    expect(courtQueue(S, 1).map(x => x.id)).toEqual(['q2', 'q3']);
  });

  test('queue rows are numbered and show team names', () => {
    expect(queueRows(state(), 0)).toEqual([
      { id: 'q1', n: 1, names: 'Ava & Leo', size: 2 },
      { id: 'q2', n: 2, names: 'Noor', size: 1 },
    ]);
  });

  test('waiting label counts teams, or players on a singles court', () => {
    expect(waitingLabel(state(), 0)).toBe('2 teams waiting');
    expect(waitingLabel(state(), 1)).toBe('No one waiting');
    const S = state({ courtModes: ['doubles', 'singles'], queue: [e('q9', ['noor'], 1)] });
    expect(waitingLabel(S, 1)).toBe('1 player waiting');
  });

  test('works against the older database with one shared queue', () => {
    const S = state({ courtModes: undefined, queue: [{ id: 'old', members: ['noor'] }] });
    expect(courtQueue(S, 0).map(x => x.id)).toEqual(['old']);
    expect(courtQueue(S, 1).map(x => x.id)).toEqual(['old']);
  });
});

describe('court slots', () => {
  test('doubles sides have two slots, open ones are null', () => {
    expect(courtSlots(state(), 1)).toEqual({ a: ['kai', null], b: [null, null] });
    expect(openSpots(state(), 1)).toBe(3);
    expect(spotsLabel(state(), 1)).toBe('3 spots open');
    expect(spotsLabel(state(), 0)).toBe('');
  });

  test('a singles court has one slot per side', () => {
    const S = state({ courtModes: ['doubles', 'singles'] });
    expect(courtSlots(S, 1)).toEqual({ a: ['kai'], b: [null] });
    expect(spotsLabel(S, 1)).toBe('1 spot open');
  });
});

describe('myPlace', () => {
  test('finds me on a court', () => {
    const S = state({ courts: [{ a: [e('x', ['me', 'jon'], 0)], b: [e('y', ['priya'], 0)] }, { a: [], b: [] }] });
    expect(myPlace(S)).toMatchObject({ where: 'court', court: 0, side: 'a' });
  });

  test('gives my position within my court queue', () => {
    const S = state({ queue: [e('q1', ['ava'], 1), e('q2', ['noor'], 0), e('mine', ['me'], 0)] });
    expect(myPlace(S)).toMatchObject({ where: 'queue', court: 0, pos: 2 });
  });

  test('null when not signed up', () => expect(myPlace(state())).toBeNull());
});

describe('bottom button', () => {
  test('nothing selected shows a disabled Join', () => {
    expect(buttonState(state(), null)).toEqual({ label: 'Join', disabled: true });
  });

  test('a full court offers its queue', () => {
    expect(buttonState(state(), { kind: 'court', court: 0 })).toEqual({ label: 'Join Court 1 queue', disabled: false, action: { k: 'join', b: { court: 0 } } });
  });

  test('a court with an open spot and nobody waiting offers the court itself', () => {
    expect(buttonState(state(), { kind: 'court', court: 1 })).toMatchObject({ label: 'Join Court 2', action: { k: 'join', b: { court: 1 } } });
  });

  test('already in this queue: disabled with my position', () => {
    const S = state({ queue: [e('q1', ['ava'], 0), e('mine', ['me'], 0)] });
    expect(buttonState(S, { kind: 'court', court: 0 })).toEqual({ label: "You're in line · #2", disabled: true });
  });

  test('waiting elsewhere: moves me to this court queue', () => {
    const S = state({ queue: [e('mine', ['me'], 1)] });
    expect(buttonState(S, { kind: 'court', court: 0 })).toMatchObject({ label: 'Join Court 1 queue', action: { k: 'moveQueue', b: { court: 0 } } });
  });

  test('a team cannot move to a singles court', () => {
    const S = state({ courtModes: ['doubles', 'singles'], queue: [e('mine', ['me', 'noor'], 0)] });
    expect(buttonState(S, { kind: 'court', court: 1 })).toEqual({ label: 'Court 2 is singles', disabled: true });
  });

  test('players on a live court get the two result buttons, named by team', () => {
    const S = state({ courts: [{ a: [e('x', ['me', 'jon'], 0)], b: [e('y', ['priya', 'sam'], 0)] }, { a: [], b: [] }] });
    expect(buttonState(S, { kind: 'court', court: 0 })).toEqual({ results: [
      { label: 'Alex & Jon won', action: { k: 'win', b: { court: 0, side: 'a' } } },
      { label: 'Priya & Sam won', action: { k: 'win', b: { court: 0, side: 'b' } } },
    ] });
  });

  test('admins get result buttons on any live court', () => {
    const S = state({ me: { id: 'me', name: 'Alex', isAdmin: true } });
    expect(buttonState(S, { kind: 'court', court: 0 }).results).toHaveLength(2);
  });

  test('non-admins not on the court never see results', () => {
    expect(buttonState(state(), { kind: 'court', court: 0 }).results).toBeUndefined();
  });

  test('on another court: disabled', () => {
    const S = state({ courts: [{ a: [e('x', ['me', 'jon'], 0)], b: [] }, { a: [e('c2a', ['kai'], 1)], b: [] }] });
    expect(buttonState(S, { kind: 'court', court: 1 })).toEqual({ label: "You're on Court 1", disabled: true });
  });

  test('tapping a single in line offers Join team', () => {
    expect(buttonState(state(), { kind: 'entry', id: 'q2' })).toEqual({ label: 'Join team', disabled: false, action: { k: 'joinTeam', b: { entryId: 'q2' } } });
  });

  test('a full team, myself, or a singles queue cannot be joined', () => {
    expect(buttonState(state(), { kind: 'entry', id: 'q1' })).toEqual({ label: 'Team is full', disabled: true });
    const mine = state({ queue: [e('mine', ['me'], 0)] });
    expect(buttonState(mine, { kind: 'entry', id: 'mine' })).toEqual({ label: "That's you · #1", disabled: true });
    const singles = state({ courtModes: ['doubles', 'singles'], queue: [e('s1', ['noor'], 1)] });
    expect(buttonState(singles, { kind: 'entry', id: 's1' })).toEqual({ label: 'Singles queue', disabled: true });
  });

  test('a player with a partner cannot join another team', () => {
    const S = state({ queue: [e('q2', ['noor'], 0), e('mine', ['me', 'kai'], 0)] });
    expect(buttonState(S, { kind: 'entry', id: 'q2' })).toEqual({ label: 'You already have a partner', disabled: true });
  });
});

describe('selection and alerts', () => {
  test('a selection that disappears is cleared', () => {
    expect(validSelection(state(), { kind: 'entry', id: 'gone' })).toBeNull();
    expect(validSelection(state(), { kind: 'entry', id: 'q1' })).toEqual({ kind: 'entry', id: 'q1' });
    expect(validSelection(state(), { kind: 'court', court: 5 })).toBeNull();
  });

  test('called up only when moving from the queue to a court', () => {
    expect(justCalledUp({ where: 'queue' }, { where: 'court' })).toBe(true);
    expect(justCalledUp(null, { where: 'court' })).toBe(false);
    expect(justCalledUp({ where: 'court' }, { where: 'court' })).toBe(false);
  });
});
