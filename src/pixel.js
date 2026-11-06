// Pixel art for the court board, drawn on the same 64×30 grid as the Claude Design canvas.

const INK = '#2B2620', CREAM = '#FFF8E7', GRASS = '#3E6B47', COURT = '#5C9A62', NET = '#EDE3CC', HANDLE = '#8A5A33';
const SHIRT = { a: '#D9733B', b: '#3D6FA6' };
const SKIN = ['#E8B894', '#C8936E', '#A8774F'];

// Sprite anchor (top-left pixel) for each slot. Doubles: back and front player per side; singles: one centred player.
const SLOTS = { 2: { a: [[13, 8], [18, 17]], b: [[45, 9], [50, 18]] }, 1: { a: [[15, 12]], b: [[47, 13]] } };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const px = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}></rect>`;
const skinOf = id => SKIN[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % SKIN.length];

export const SHUTTLE = `<svg class="logo" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${
  px(1, 0, 6, 1, INK) + px(1, 1, 1, 3, INK) + px(6, 1, 1, 3, INK) + px(2, 1, 4, 3, CREAM) + px(2, 4, 4, 1, INK) + px(3, 5, 2, 3, SHIRT.a)}</svg>`;

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
