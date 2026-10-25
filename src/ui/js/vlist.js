// Minimal virtual list: renders only the rows in view. Rows are absolutely positioned.
export class VList {
  /**
   * @param {HTMLElement} el scroll container
   * @param {{rowH:number, render:(node:HTMLElement,i:number)=>void, className?:string, make?:()=>HTMLElement}} o
   */
  constructor(el, o) {
    this.el = el; this.rowH = o.rowH; this.render = o.render; this.className = o.className || '';
    this.count = 0; this.nodes = new Map(); this._raf = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'vl-spacer';
    el.appendChild(this.spacer);
    el.addEventListener('scroll', () => this._schedule(), { passive: true });
    new ResizeObserver(() => this._schedule()).observe(el);
  }
  rowHeight() { return this.rowH; }
  setCount(n) { this.count = n; this.spacer.style.height = n * this.rowH + 'px'; this.refresh(); }
  _schedule() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._update(false); }); }
  refresh() { this._update(true); }
  _update(force) {
    const h = this.el.clientHeight, top = this.el.scrollTop;
    const first = Math.max(0, Math.floor(top / this.rowH) - 3);
    const last = Math.min(this.count - 1, Math.ceil((top + h) / this.rowH) + 3);
    for (const [i, node] of this.nodes) {
      if (i < first || i > last) { node.remove(); this.nodes.delete(i); }
    }
    for (let i = first; i <= last; i++) {
      let node = this.nodes.get(i);
      if (!node) {
        node = document.createElement('div');
        node.className = 'vl-row ' + this.className;
        node.style.top = i * this.rowH + 'px';
        this.el.appendChild(node);
        this.nodes.set(i, node);
        this.render(node, i);
      } else if (force) {
        this.render(node, i);
      }
    }
  }
  nodeAt(i) { return this.nodes.get(i); }
  scrollTo(i, where = 'nearest') {
    if (i < 0 || i >= this.count) return;
    const top = i * this.rowH, h = this.el.clientHeight;
    if (where === 'center') this.el.scrollTop = Math.max(0, top - h / 2 + this.rowH / 2);
    else if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + this.rowH > this.el.scrollTop + h) this.el.scrollTop = top + this.rowH - h;
    this._update(false);
  }
  indexAtY(clientY) {
    const r = this.el.getBoundingClientRect();
    return Math.floor((clientY - r.top + this.el.scrollTop) / this.rowH);
  }
}
