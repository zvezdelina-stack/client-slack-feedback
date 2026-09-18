// summaryListeners.js
//
// Peer-summary review controls for the existing client-feedback Bolt app.
// Handles the Send / Edit / Dismiss buttons and the Edit modal on the draft
// DM that SFUtilities posts to the reviewer (Z). All namespaced "summary_*"
// so they can't collide with the client-feedback function or view.
//
// Wire in app.js:
//   const registerSummaryListeners = require('./summaryListeners');
//   registerSummaryListeners(app);
//
// Uses env var SFUTILITIES_URL (already set on this service).
// No new scopes needed for these listeners; the draft DM and the evaluatee DM
// are posted by SFUtilities, not here. This app only reacts to the buttons.

const SFU = process.env.SFUTILITIES_URL;

async function sfu(path, { method = 'POST', body } = {}) {
  const r = await fetch(`${SFU}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(data.error || `SFUtilities ${path} -> HTTP ${r.status}`);
  }
  return data;
}

// Rebuild the DM as a terminal state (buttons removed) after an action.
function resolvedBlocks(originalBlocks, statusLine) {
  const kept = (originalBlocks || []).filter(b => b.type !== 'actions');
  kept.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statusLine }] });
  return kept;
}

module.exports = function registerSummaryListeners(app) {
  // ---- Send: deliver the current draft to the evaluatee ----
  app.action('summary_send', async ({ ack, body, client, action, logger }) => {
    await ack();
    const id = action.value;
    try {
      const res = await sfu('/assessment-summary/send', { body: { id } });
      const status = res.delivered
        ? `:white_check_mark: Sent to ${res.to}`
        : (res.alreadySent
            ? `:white_check_mark: Already sent to ${res.to}`
            : `:warning: Could not auto-send to ${res.to} (${res.reason}). Sent to you to deliver manually.`);
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: status,
        blocks: resolvedBlocks(body.message.blocks, status),
      });
    } catch (e) {
      logger.error(e);
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id,
        text: `Send failed: ${e.message}`,
      }).catch(() => {});
    }
  });

  // ---- Dismiss: decline the draft, do not send ----
  app.action('summary_dismiss', async ({ ack, body, client, action, logger }) => {
    await ack();
    const id = action.value;
    try {
      await sfu('/assessment-summary/dismiss', { body: { id } });
      const status = `:no_entry_sign: Dismissed`;
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: status,
        blocks: resolvedBlocks(body.message.blocks, status),
      });
    } catch (e) {
      logger.error(e);
    }
  });

  // ---- Edit: open a modal prefilled with the current draft ----
  app.action('summary_edit', async ({ ack, body, client, action, logger }) => {
    await ack();
    const id = action.value;
    try {
      const { draft } = await sfu(`/assessment-summary/get?id=${encodeURIComponent(id)}`, { method: 'GET' });
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'summary_edit_modal',
          // Carry what the submit handler needs to update the original message.
          private_metadata: JSON.stringify({
            id,
            channel: body.channel.id,
            ts: body.message.ts,
            evaluatee: draft.evaluatee,
            block_number: draft.block_number,
          }),
          title: { type: 'plain_text', text: 'Edit summary' },
          submit: { type: 'plain_text', text: 'Save' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'draft',
              label: { type: 'plain_text', text: `Summary for ${draft.evaluatee}`.slice(0, 150) },
              element: {
                type: 'plain_text_input',
                action_id: 'text',
                multiline: true,
                initial_value: (draft.draft_text || '').slice(0, 3000),
              },
            },
          ],
        },
      });
    } catch (e) {
      logger.error(e);
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id,
        text: `Couldn't open editor: ${e.message}`,
      }).catch(() => {});
    }
  });

  // ---- Edit modal submit: save, then re-render the DM with buttons ----
  app.view('summary_edit_modal', async ({ ack, view, client, logger }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}');
    const newText = view.state.values.draft.text.value;
    try {
      await sfu('/assessment-summary/update', { body: { id: meta.id, text: newText } });

      const header = `:memo: *Peer summary draft — ${meta.evaluatee}` +
        (meta.block_number ? ` (block ${meta.block_number})` : '') + `*  _#${meta.id}_  _(edited)_`;
      await client.chat.update({
        channel: meta.channel,
        ts: meta.ts,
        text: `Peer summary draft for ${meta.evaluatee} (edited)`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: header } },
          { type: 'section', text: { type: 'mrkdwn', text: newText.slice(0, 2900) } },
          {
            type: 'actions',
            block_id: 'summary_actions',
            elements: [
              { type: 'button', action_id: 'summary_send', style: 'primary',
                text: { type: 'plain_text', text: `Send to ${meta.evaluatee}`.slice(0, 75) }, value: String(meta.id) },
              { type: 'button', action_id: 'summary_edit',
                text: { type: 'plain_text', text: 'Edit' }, value: String(meta.id) },
              { type: 'button', action_id: 'summary_dismiss', style: 'danger',
                text: { type: 'plain_text', text: 'Dismiss' }, value: String(meta.id) },
            ],
          },
        ],
      });
    } catch (e) {
      logger.error(e);
    }
  });
};
