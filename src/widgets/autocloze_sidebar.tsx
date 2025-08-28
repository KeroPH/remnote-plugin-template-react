import React from 'react';
import { renderWidget } from '@remnote/plugin-sdk';
import { SelectedCloze } from './selected_cloze';

const AutoClozeSidebar = () => (
  <div style={{ padding: 0}}>
    <SelectedCloze />
  </div>
);

// SidebarEnd can sometimes mount before its DOM container exists in some clients.
// We retry a few times to avoid the unmountComponentAtNode DOM element error.
let attempts = 0;
const maxAttempts = 5;
function safeRender() {
  try {
    renderWidget(AutoClozeSidebar);
  } catch (e) {
    if (attempts < maxAttempts) {
      attempts++;
      setTimeout(safeRender, 200 * attempts); // backoff
    } else {
      // Swallow after retries; user can still use the SelectedTextMenu widget.
      console.error('AutoCloze SidebarEnd mount failed after retries:', e);
    }
  }
}
safeRender();
