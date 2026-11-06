import { describe, expect, test } from 'vitest';
import { adminButtons, buttonState, courtLayout, courtQueue, dropAction, pairAction, placeLabel, courtSlots, justCalledUp, myPlace, openSpots, queueRows, resolveSide, spotsLabel, validSelection, waitingLabel } from './logic.js';

const names = { me: 'Alex', maya: 'Maya', jon: 'Jon', priya: 'Priya', sam: 'Sam', ava: 'Ava', leo: 'Leo', noor: 'Noor', kai: 'Kai' };
const e = (id, members, queueCourt = null) => ({ id, members, queueCourt, streak: 0 });

/** Court 1 full (Maya & Jon vs Priya & Sam), Court 2 has Kai alone on the left; queues per court. */
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
const court = (c, side) => ({ kind: 'court', court: c, side });
const labels = st => st.buttons.map(b => b.label);
const meOnCourt1 = () => state({ courts: [{ a: [e('x', ['me', 'jon'], 0)], b: [e('y', ['priya', 'sam'], 0)] }, { a: [e('c2a', ['kai'], 1)], b: [] }] });

describe('court queues', () => {
  test('each court lists only its own queue, plus legacy any-court entries', () => {
    const S = state({ queue: [e('q1', ['ava'], 0), e('q2', ['noor'], 1), e('q3', ['leo'], null)] });
    expect(courtQueue(S, 0).map(x => x.id)).toEqual(['q1', 'q3']);
    expect(courtQueue(S, 1).map(x => x.id)).toEqual(['q2', 'q3']);
  });

  test('queue rows are numbered and show team names', () => {
    expect(queueRows(state(), 0)).toEqual([
      { id: 'q1', n: 1, names: 'Ava & Leo', size: 2, members: ['ava', 'leo'] },
      { id: 'q2', n: 2, names: 'Noor', size: 1, members: ['noor'] },
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

describe('court slots and sides', () => {
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

  test('a preview puts me in the first open slot of the picked side', () => {
    expect(courtSlots(state(), 1, { court: 1, side: 'b' })).toEqual({ a: ['kai', null], b: ['me', null] });
    expect(courtSlots(state(), 1, { court: 1, side: 'a' })).toEqual({ a: ['kai', 'me'], b: [null, null] });
    expect(courtSlots(state(), 0, { court: 1, side: 'a' }).a).toEqual(['maya', 'jon']);
  });

  test('the clicked side is used when it has room, otherwise the other side, otherwise the queue', () => {
    const S = state({ courts: [{ a: [e('c1a', ['maya', 'jon'], 0)], b: [e('c1b', ['priya'], 0)] }, { a: [], b: [] }] });
    expect(resolveSide(S, 0, 'b')).toBe('b');
    expect(resolveSide(S, 0, 'a')).toBe('b');
    expect(resolveSide(S, 1, null)).toBe('a');
    expect(resolveSide(state(), 0, 'a')).toBeNull();
  });
});

describe('myPlace', () => {
  test('finds me on a court', () => {
    expect(myPlace(meOnCourt1())).toMatchObject({ where: 'court', court: 0, side: 'a' });
  });

  test('gives my position within my court queue', () => {
    const S = state({ queue: [e('q1', ['ava'], 1), e('q2', ['noor'], 0), e('mine', ['me'], 0)] });
    expect(myPlace(S)).toMatchObject({ where: 'queue', court: 0, pos: 2 });
  });

  test('null when not signed up', () => expect(myPlace(state())).toBeNull());
});

describe('bottom buttons', () => {
  test('no bar until something is selected', () => {
    expect(buttonState(state(), null)).toBeNull();
  });

  test('a full court offers its queue', () => {
    expect(buttonState(state(), court(0, 'a'))).toEqual({ buttons: [{ label: 'Join Court 1 queue', disabled: false, action: { k: 'join', b: { court: 0 } } }], preview: null });
  });

  test('an open court joins the clicked side and previews me there', () => {
    expect(buttonState(state(), court(1, 'b'))).toEqual({
      buttons: [{ label: 'Join Court 2', disabled: false, action: { k: 'joinCourt', b: { court: 1, side: 'b' } } }],
      preview: { court: 1, side: 'b' },
    });
  });

  test('my own court, on it or in its queue, offers Leave', () => {
    const queued = state({ queue: [e('q1', ['ava'], 0), e('mine', ['me'], 0)] });
    expect(labels(buttonState(queued, court(0)))).toEqual(['Leave']);
    const S = meOnCourt1();
    S.courts[0].b = [];
    expect(buttonState(S, court(0))).toEqual({ buttons: [{ label: 'Leave', disabled: false, action: { k: 'leave', b: {} } }], preview: null });
  });

  test('on a live court I get both results plus a secondary Leave', () => {
    const st = buttonState(meOnCourt1(), court(0));
    expect(labels(st)).toEqual(['Alex & Jon won', 'Priya & Sam won', 'Leave']);
    expect(st.buttons[0].action).toEqual({ k: 'win', b: { court: 0, side: 'a' } });
    expect(st.buttons[2].secondary).toBe(true);
  });

  test('on a court, another court offers Leave & join, with a side when there is room', () => {
    expect(buttonState(meOnCourt1(), court(1, 'b'))).toEqual({
      buttons: [{ label: 'Leave & join Court 2', disabled: false, action: { k: 'switchCourt', b: { court: 1, side: 'b' } } }],
      preview: { court: 1, side: 'b' },
    });
  });

  test('waiting elsewhere, a full court offers Leave & join its queue', () => {
    const S = state({ queue: [e('mine', ['me'], 1)] });
    expect(buttonState(S, court(0, 'a'))).toEqual({ buttons: [{ label: 'Leave & join Court 1 queue', disabled: false, action: { k: 'switchCourt', b: { court: 0, side: null } } }], preview: null });
  });

  test('a waiting team moves together instead of leaving', () => {
    const S = state({ queue: [e('mine', ['me', 'noor'], 1)] });
    expect(buttonState(S, court(0))).toMatchObject({ buttons: [{ label: 'Move team to Court 1', action: { k: 'moveQueue', b: { court: 0 } } }] });
    const singles = state({ courtModes: ['doubles', 'singles'], queue: [e('mine', ['me', 'noor'], 0)] });
    expect(labels(buttonState(singles, court(1)))).toEqual(['Court 2 is singles']);
  });

  test('admins get result buttons on any live court, with their own action after', () => {
    const S = state({ me: { id: 'me', name: 'Alex', isAdmin: true } });
    const st = buttonState(S, court(0));
    expect(labels(st)).toEqual(['Maya & Jon won', 'Priya & Sam won', 'Join Court 1 queue']);
    expect(st.buttons[2].secondary).toBe(true);
  });

  test('non-admins not on the court never see results', () => {
    expect(labels(buttonState(state(), court(0)))).toEqual(['Join Court 1 queue']);
  });

  test('tapping a single in line offers Join team', () => {
    expect(buttonState(state(), { kind: 'entry', id: 'q2' })).toEqual({ buttons: [{ label: 'Join team', disabled: false, action: { k: 'joinTeam', b: { entryId: 'q2' } } }], preview: null });
  });

  test('tapping my own row offers Leave', () => {
    const S = state({ queue: [e('mine', ['me'], 0)] });
    expect(labels(buttonState(S, { kind: 'entry', id: 'mine' }))).toEqual(['Leave']);
  });

  test('a full team or a singles queue cannot be joined', () => {
    expect(labels(buttonState(state(), { kind: 'entry', id: 'q1' }))).toEqual(['Team is full']);
    const singles = state({ courtModes: ['doubles', 'singles'], queue: [e('s1', ['noor'], 1)] });
    expect(buttonState(singles, { kind: 'entry', id: 's1' }).buttons[0]).toEqual({ label: 'Singles queue', disabled: true });
  });

  test('a player with a partner cannot join another team', () => {
    const S = state({ queue: [e('q2', ['noor'], 0), e('mine', ['me', 'kai'], 0)] });
    expect(labels(buttonState(S, { kind: 'entry', id: 'q2' }))).toEqual(['You already have a partner']);
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

describe('admin drops', () => {
  // Court 1: Maya & Jon (team) vs Priya & Sam (team). Court 2: Kai alone on the left. Court 1 queue: Ava & Leo, Noor.
  const S = state();
  const player = user => ({ kind: 'player', user });
  const entry = id => ({ kind: 'entry', id });

  test('a court player onto an open side moves just them', () => {
    expect(dropAction(S, player('jon'), { kind: 'side', court: 1, side: 'b' }))
      .toEqual({ k: 'place', b: { court: 1, side: 'b', userId: 'jon' }, msg: 'Moved Jon to Court 2' });
  });

  test('a team in line onto an open side moves together, if the side has room for both', () => {
    expect(dropAction(S, entry('q1'), { kind: 'side', court: 1, side: 'b' }))
      .toEqual({ k: 'place', b: { court: 1, side: 'b', entryId: 'q1' }, msg: 'Moved Ava & Leo to Court 2' });
    expect(dropAction(S, entry('q1'), { kind: 'side', court: 1, side: 'a' })).toEqual({ error: 'That side of Court 2 has no room for a team.' });
  });

  test('a full side asks for a swap instead; the same side does nothing', () => {
    expect(dropAction(S, entry('q2'), { kind: 'side', court: 0, side: 'a' })).toEqual({ error: 'That side is full. Drop onto a player to swap them.' });
    expect(dropAction(S, player('maya'), { kind: 'side', court: 0, side: 'a' })).toBeNull();
  });

  test('onto another player swaps the two; a teammate does nothing', () => {
    expect(dropAction(S, player('jon'), player('priya'))).toEqual({ k: 'swap', b: { a: 'jon', b: 'priya' }, msg: 'Swapped Jon and Priya' });
    expect(dropAction(S, entry('q2'), player('kai'))).toEqual({ k: 'swap', b: { a: 'noor', b: 'kai' }, msg: 'Swapped Noor and Kai' });
    expect(dropAction(S, player('maya'), player('jon'))).toBeNull();
    expect(dropAction(S, entry('q1'), player('kai')).k).toBe('swapEntries');  // a whole team trades places with Kai
  });

  test('into a queue: before a row, or at the end', () => {
    expect(dropAction(S, entry('q2'), { kind: 'row', court: 0, id: 'q1' }))
      .toEqual({ k: 'queue', b: { court: 0, before: 'q1', entryId: 'q2' }, msg: 'Moved Noor in line for Court 1' });
    expect(dropAction(S, player('kai'), { kind: 'queueEnd', court: 0 }))
      .toEqual({ k: 'queue', b: { court: 0, before: null, userId: 'kai' }, msg: 'Moved Kai in line for Court 1' });
  });

  test('a drop that leaves the line as it is does nothing', () => {
    expect(dropAction(S, entry('q1'), { kind: 'row', court: 0, id: 'q1' })).toBeNull();
    expect(dropAction(S, entry('q1'), { kind: 'row', court: 0, id: 'q2' })).toBeNull();
    expect(dropAction(S, entry('q2'), { kind: 'queueEnd', court: 0 })).toBeNull();
  });

  test("teams can't wait for a singles court", () => {
    const singles = { ...S, courtModes: ['doubles', 'singles'] };
    expect(dropAction(singles, entry('q1'), { kind: 'queueEnd', court: 1 })).toEqual({ error: "Court 2 is singles, so teams can't wait for it." });
  });

  test('the bin removes a player, or a whole team in line', () => {
    expect(dropAction(S, player('jon'), { kind: 'bin' })).toEqual({ k: 'kick', b: { userId: 'jon' }, msg: 'Removed Jon' });
    expect(dropAction(S, entry('q1'), { kind: 'bin' })).toEqual({ k: 'removePair', b: { entryId: 'q1' }, msg: 'Removed Ava & Leo' });
    expect(dropAction(S, entry('q2'), { kind: 'bin' })).toEqual({ k: 'kick', b: { userId: 'noor' }, msg: 'Removed Noor' });
  });

  test('a player who already left: nothing happens', () => {
    expect(dropAction(S, player('ghost'), { kind: 'bin' })).toBeNull();
  });
});

describe('admin pairing', () => {
  const S = state();  // Court 1: Maya & Jon vs Priya & Sam. Court 2: Kai alone on the left. Court 1 queue: Ava & Leo, Noor.

  test('a single gets Team up, Remove; a team member also gets Split', () => {
    expect(adminButtons(S, { kind: 'player', user: 'noor' }).buttons.map(b => b.label)).toEqual(['Team Noor up with…', 'Remove Noor']);
    const jon = adminButtons(S, { kind: 'player', user: 'jon' }).buttons;
    expect(jon.map(b => b.label)).toEqual(['Pair Jon with someone else', 'Split from Maya', 'Remove Jon']);
    expect(jon[1].action).toEqual({ k: 'split', b: { userId: 'jon' } });
    expect(jon[0].local).toBe('pairStart');
  });

  test('after Team up, the bar asks for the partner and offers Cancel', () => {
    expect(adminButtons(S, { kind: 'pairWith', user: 'noor' }).buttons.map(b => b.label)).toEqual(["Now tap Noor's new partner", 'Cancel']);
  });

  test('pairing joins the tapped player where they are', () => {
    expect(pairAction(S, 'noor', 'kai')).toEqual({ k: 'pair', b: { userId: 'noor', targetId: 'kai' }, msg: 'Noor and Kai are now a team' });
    expect(pairAction(S, 'jon', 'noor').k).toBe('pair');  // Jon may leave Maya for Noor
  });

  test('refused: already a team, a target with a partner, a singles court, a full side', () => {
    expect(pairAction(S, 'maya', 'jon').error).toMatch(/already a team/);
    expect(pairAction(S, 'noor', 'priya').error).toBe('Priya already has a partner. Split them up first.');
    expect(pairAction({ ...S, courtModes: ['doubles', 'singles'] }, 'noor', 'kai').error).toMatch(/singles/);
    const crowded = { ...S, courts: [S.courts[0], { a: [{ id: 'k', members: ['kai'] }, { id: 'r', members: ['sam2'] }], b: [] }] };
    expect(pairAction(crowded, 'noor', 'kai').error).toMatch(/No room/);
    expect(pairAction(crowded, 'sam2', 'kai').k).toBe('pair');  // two singles on that side may team up
  });

  test('a selected player who leaves the board is cleared', () => {
    expect(validSelection(S, { kind: 'player', user: 'noor' })).toEqual({ kind: 'player', user: 'noor' });
    expect(validSelection(S, { kind: 'pairWith', user: 'ghost' })).toBeNull();
  });
});

describe('court tools', () => {
  const S = state();  // Court 1: Maya & Jon vs Priya & Sam (teams). Court 2: Kai alone on the left. Court 1 queue: Ava & Leo, Noor.

  test('teams are drawn as one group; singles and open spots one by one', () => {
    expect(courtLayout(S, 0)).toEqual({ cap: 2, a: [{ team: 'c1a', members: ['maya', 'jon'] }], b: [{ team: 'c1b', members: ['priya', 'sam'] }] });
    expect(courtLayout(S, 1)).toEqual({ cap: 2, a: [{ id: 'kai' }, { open: true }], b: [{ open: true }, { open: true }] });
    expect(courtLayout(S, 1, { court: 1, side: 'b' }).b).toEqual([{ id: 'me', preview: true }, { open: true }]);
    const two = { ...S, courts: [S.courts[0], { a: [{ id: 'k', members: ['kai'] }, { id: 'n', members: ['noor'] }], b: [] }] };
    expect(courtLayout(two, 1).a).toEqual([{ id: 'kai' }, { id: 'noor' }]);  // two singles are not a team
  });

  test('a solo waiting for a court can take its open spot by hand', () => {
    const S2 = { ...S, courts: [{ a: [{ id: 'm', members: ['maya'] }], b: S.courts[0].b }, S.courts[1]], queue: [e('q1', ['ava', 'leo'], 0), e('mine', ['me'], 0)] };
    const st = buttonState(S2, court(0, null));
    expect(labels(st)).toEqual(['Join Court 1', 'Leave']);
    expect(st.buttons[0].action).toEqual({ k: 'switchCourt', b: { court: 0, side: 'a' } });
    expect(st.preview).toEqual({ court: 0, side: 'a' });
  });

  test('a waiting team does not get Join for a single open spot', () => {
    const S2 = { ...S, courts: [{ a: [{ id: 'm', members: ['maya'] }], b: S.courts[0].b }, S.courts[1]], queue: [e('mine', ['me', 'noor'], 0)] };
    expect(labels(buttonState(S2, court(0, null)))).toEqual(['Leave']);
  });

  test('a team dragged onto a team or a player swaps their places', () => {
    expect(dropAction(S, { kind: 'entry', id: 'c1a' }, { kind: 'team', id: 'q1' }))
      .toEqual({ k: 'swapEntries', b: { a: 'c1a', b: 'q1' }, msg: 'Swapped Maya & Jon and Ava & Leo' });
    expect(dropAction(S, { kind: 'entry', id: 'q1' }, { kind: 'player', user: 'kai' }))
      .toEqual({ k: 'swapEntries', b: { a: 'q1', b: 'c2a' }, msg: 'Swapped Ava & Leo and Kai' });
    expect(dropAction(S, { kind: 'entry', id: 'q2' }, { kind: 'team', id: 'c1b' }).k).toBe('swapEntries');  // a single trades with a team
    expect(dropAction(S, { kind: 'entry', id: 'c1a' }, { kind: 'team', id: 'c1a' })).toBeNull();
    expect(dropAction(S, { kind: 'player', user: 'leo' }, { kind: 'team', id: 'c1a' }).error).toMatch(/split them up/);
  });

  test('a team on court can be dragged off to a queue or onto an open side', () => {
    expect(dropAction(S, { kind: 'entry', id: 'c1b' }, { kind: 'queueEnd', court: 0 }).k).toBe('queue');
    expect(dropAction(S, { kind: 'entry', id: 'c1b' }, { kind: 'side', court: 1, side: 'b' }).k).toBe('place');
  });

  test('the player list says where everyone is', () => {
    expect(placeLabel(S, 'jon')).toBe('On Court 1 with Maya');
    expect(placeLabel(S, 'noor')).toBe('In line for Court 1');
    expect(placeLabel(S, 'leo')).toBe('In line for Court 1 with Ava');
    expect(placeLabel(S, 'zed')).toBe('Not signed up');
  });
});
