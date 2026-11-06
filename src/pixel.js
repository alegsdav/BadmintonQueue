// Pixel art for the court board, drawn on the same 64×30 grid as the Claude Design canvas.

const INK = '#2B2620', CREAM = '#FFF8E7', GRASS = '#3E6B47', COURT = '#5C9A62', NET = '#EDE3CC', HANDLE = '#8A5A33';
const SHIRT = { a: '#D9733B', b: '#3D6FA6' };
const SKIN = ['#E8B894', '#C8936E', '#A8774F'];

// Sprite anchor (top-left pixel) for each slot. Doubles: back and front player per side; singles: one centred player.
const SLOTS = { 2: { a: [[13, 8], [18, 17]], b: [[45, 9], [50, 18]] }, 1: { a: [[15, 12]], b: [[47, 13]] } };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const px = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}></rect>`;
const skinOf = id => SKIN[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % SKIN.length];

// Slugminton racket logo, 37×37, from the "Racket" artboard. Each run is "x,y,w" (one pixel tall); w defaults to 1.
const RACKET_LAYERS = [
  ['#FFF8E7', '27,4,3 24,5,8 22,6,10 21,7,12 20,8,13 20,9,13 19,10,13 19,11,13 19,12,13 18,13,13 18,14,13 18,15,12 19,16,10 19,17,8 21,18,3'],
  ['strings', '28,4 27,5 31,5 22,6 24,6 26,6 28,6 30,6 21,7 25,7 29,7 20,8 22,8 24,8 26,8 28,8 30,8 32,8 23,9 27,9 31,9 20,10 22,10 24,10 26,10 28,10 30,10 21,11 25,11 29,11 20,12 22,12 24,12 26,12 28,12 30,12 19,13 23,13 27,13 18,14 20,14 22,14 24,14 26,14 28,14 30,14 21,15 25,15 29,15 20,16 22,16 24,16 26,16 28,16 19,17 23,17 22,18'],
  ['#FFE27A', '27,1,2 24,2,4 22,3,5 20,4,4 19,5,3 18,6,2 18,7,2 17,8,2 17,9,2 16,10,2 16,11,2 16,12,2 15,13,2 15,14'],
  ['#F2C230', '29,1 28,2,5 30,3,4 33,4,2 33,5,2 33,6,2 34,7,2 34,8 16,14 15,15,2 16,16,2 16,17,2 16,18,2 17,19,4 18,20,5 21,21'],
  ['#C9961C', '35,8 34,9,2 33,10,2 33,11,2 33,12,2 32,13,2 32,14,2 31,15,2 31,16,2 29,17,3 27,18,4 24,19,5 23,20,4 22,21,2'],
  ['#8B8F99', '15,21 14,22 13,23 12,24 11,25 10,26 9,27'],
  ['#3D6FA6', '7,28 5,29,2 8,29 5,30,3 3,31,2 6,31,2 3,32,3 1,33,2 4,33,2 1,34,3 2,35,2'],
  ['#7FA3CF', '6,28 7,29 4,30 8,30 5,31 2,32 6,32 3,33 4,34'],
  [INK, '27,0,3 24,1,3 30,1,3 22,2,2 33,2 20,3,2 27,3,3 34,3 19,4 24,4,3 30,4,3 35,4 18,5 22,5,2 32,5 35,5 17,6 20,6,2 32,6 35,6 17,7 20,7 33,7 36,7 16,8 19,8 33,8 36,8 16,9 19,9 33,9 36,9 15,10 18,10 32,10 35,10 15,11 18,11 32,11 35,11 15,12 18,12 32,12 35,12 14,13 17,13 31,13 34,13 14,14 17,14 31,14 34,14 14,15 17,15 30,15 33,15 15,16 18,16 29,16,2 33,16 15,17 18,17 27,17,2 32,17 15,18 18,18,3 24,18,3 31,18 15,19,2 21,19,3 29,19,2 15,20,3 27,20,2 14,21 16,21,5 24,21,3 13,22 15,22 21,22,3 12,23 14,23 11,24 13,24 10,25 12,25 9,26 11,26 6,27,3 10,27 5,28 8,28,2 4,29 9,29 3,30 9,30 2,31 8,31 1,32 7,32 0,33 6,33 0,34 5,34 1,35 4,35 2,36,2'],
];
const STRING_COLOR = '#CBB99A';

/** The racket as SVG markup. Strings are dropped at small sizes so it stays crisp, as in the logo sheet. */
export function racket({ strings = false, cls = 'logo' } = {}) {
  const body = RACKET_LAYERS.map(([color, runs]) => {
    if (color === 'strings' && !strings) return '';
    const fill = color === 'strings' ? STRING_COLOR : color;
    return runs.split(' ').map(run => { const [x, y, w = 1] = run.split(',').map(Number); return px(x, y, w, 1, fill); }).join('');
  }).join('');
  return `<svg class="${cls}" viewBox="0 0 37 37" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}

const LINES = [[4, 3, 56, 1], [4, 26, 56, 1], [4, 3, 1, 24], [59, 3, 1, 24], [4, 5, 56, 1], [4, 24, 56, 1], [7, 3, 1, 24], [56, 3, 1, 24],
  [24, 3, 1, 24], [39, 3, 1, 24], [4, 14, 20, 1], [40, 14, 20, 1]].map(([x, y, w, h]) => px(x, y, w, h, CREAM)).join('');

const NET_ART = px(31, 2, 2, 26, NET) + px(32, 3, 1, 24, INK, ' opacity="0.35"') + px(31, 1, 2, 2, INK) + px(31, 27, 2, 2, INK);

function sprite([x, y], side, id) {
  const r = side === 'a' ? x + 2 : x - 1;
  return px(x, y, 2, 1, INK) + px(x, y + 1, 2, 1, skinOf(id)) + px(x, y + 2, 2, 2, SHIRT[side]) + px(x, y + 4, 2, 1, INK)
    + px(r, y - 1, 1, 2, CREAM) + px(r, y + 1, 1, 1, HANDLE);
}

const pct = (v, total) => `${((v / total) * 100).toFixed(1)}%`;

/**
 * The court art plus HTML overlays (name tags for players, dashed "+" squares for open spots).
 * @param {{a: (string|null)[], b: (string|null)[]}} slots user ids or null per slot
 * @param {(id: string) => string} nameOf
 * @param {boolean} live a game is in play (draws the shuttle)
 * @param {string} meId the signed-in player, whose tag is highlighted
 */
export function courtArt(slots, nameOf, live, meId) {
  const cap = slots.a.length;
  let sprites = '', overlays = '';
  for (const side of ['a', 'b']) {
    slots[side].forEach((id, i) => {
      const [x, y] = SLOTS[cap][side][i];
      if (id) {
        sprites += sprite([x, y], side, id);
        overlays += `<span class="tag${id === meId ? ' me' : ''}" style="left:${pct(x + 1, 64)};top:${pct(y + 5.6, 30)}">${esc(nameOf(id))}</span>`;
      } else {
        overlays += `<span class="open" style="left:${pct(x + 1, 64)};top:${pct(y + 2.5, 30)}" aria-hidden="true"></span>`;
      }
    });
  }
  const shuttle = live ? px(36, 11, 1, 1, '#FFFFFF') + px(37, 11, 1, 1, INK, ' opacity="0.5"') : '';
  return `<span class="art"><svg viewBox="0 0 64 30" shape-rendering="crispEdges" aria-hidden="true">${
    px(0, 0, 64, 30, GRASS) + px(4, 3, 56, 24, COURT) + LINES + NET_ART + sprites + shuttle}</svg>${overlays}</span>`;
}

export { esc };
