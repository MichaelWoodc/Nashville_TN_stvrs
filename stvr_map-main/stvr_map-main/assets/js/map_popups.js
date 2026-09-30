function layoutListingPopup(content) {
  const frame = document.createElement('div');
  frame.className = 'listing-popup-frame';
  const body = document.createElement('div');
  body.className = 'listing-popup-body';
  body.appendChild(content);
  const header = document.createElement('div');
  header.className = 'listing-popup-header';
  const title = body.querySelector('.popup-title');
  if (title) header.appendChild(title);
  const footer = document.createElement('div');
  footer.className = 'listing-popup-actions';
  const selector = '.listing-action-grid, .popup-actions, .popup-pagination-container, .popup-links, button, a.action-link, a.airbnb-link, a.popup-link';
  // Move existing nodes so their click listeners and IDs remain intact.
  const actions = [...body.querySelectorAll(selector)];
  actions.filter(node => !actions.some(parent => parent !== node && parent.contains(node)))
    .forEach(node => footer.appendChild(node));
  frame.append(header, body, footer);
  return frame;
}

/* Keep the close control outside the scrolling popup body. */
class ListingMapPopup extends maplibregl.Popup {
  constructor(options = {}) {
    super(options);
    this.requestedAnchor = options.anchor;
  }

  setDOMContent(content) {
    return super.setDOMContent(layoutListingPopup(content));
  }

  addTo(map) {
    // MapLibre's automatic anchor can put a tall card below a low dot.
    // Choose from the dot's screen position before displaying the card.
    if (!this.requestedAnchor) {
      const point = map.project(this.getLngLat());
      const height = map.getContainer().clientHeight;
      const width = map.getContainer().clientWidth;
      const vertical = point.y >= height / 2 ? 'bottom' : 'top';
      const horizontal = point.x < width / 4 ? '-left' : point.x > width * 3 / 4 ? '-right' : '';
      this.options.anchor = vertical + horizontal;
    }
    super.addTo(map);
    if (!this.requestedAnchor) {
      const point = map.project(this.getLngLat());
      const height = map.getContainer().clientHeight;
      const available = this.options.anchor.startsWith('bottom') ? point.y : height - point.y;
      const body = this.getElement().querySelector('.listing-popup-frame');
      if (body) body.style.maxHeight = `${Math.max(80, available - 90)}px`;
    }
    return this;
  }
}
