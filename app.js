// app.js
// SwingSearch Client Feedback - Bolt custom step for Workflow Builder (Socket Mode).
// Flow: the custom step fetches candidates for the channel's search, opens a modal
// with a candidate dropdown plus a feedback box, and on submit creates a Note in
// Seven20 by calling the SFUtilities endpoints. Uses global fetch (Node 18+).
//
// Env vars:
//   SLACK_BOT_TOKEN  - xoxb-... (from installing the app)
//   SLACK_APP_TOKEN  - xapp-... (app-level token with connections:write, for Socket Mode)
//   SFUTILITIES_URL  - e.g. https://sf-utilities-production.up.railway.app

const { App } = require('@slack/bolt');

const SFUTILITIES_URL = process.env.SFUTILITIES_URL;
const STEP_CALLBACK = 'collect_client_feedback';
const MODAL_CALLBACK = 'feedback_modal';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// 1) The custom step fires when the client starts the workflow.
//    Load candidates for the channel's search and open the feedback modal.
//    Do NOT complete() here; the modal submission completes the step.
app.function(STEP_CALLBACK, async ({ inputs, client, fail, context, body, logger }) => {
  try {
    const channelId = inputs.channel_id;
    const functionExecutionId =
      context.functionExecutionId ||
      (body && body.event && body.event.function_execution_id);

    const res = await fetch(`${SFUTILITIES_URL}/sf/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      await fail({ error: (data && data.error) || 'Could not load candidates for this channel.' });
      return;
    }
    if (!data.candidates || data.candidates.length === 0) {
      await fail({ error: 'This search has no candidates yet.' });
      return;
    }

    // Slack static_select allows up to 100 options; names cap at 75 chars.
    const options = data.candidates.slice(0, 100).map((c) => ({
      text: { type: 'plain_text', text: String(c.candidateName).slice(0, 75) },
      value: c.applicationId,
    }));

    await client.views.open({
      interactivity_pointer: inputs.interactivity.interactivity_pointer,
      view: {
        type: 'modal',
        callback_id: MODAL_CALLBACK,
        private_metadata: JSON.stringify({ channelId, functionExecutionId }),
        title: { type: 'plain_text', text: 'Client Feedback' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'candidate_block',
            label: { type: 'plain_text', text: 'Candidate' },
            element: {
              type: 'static_select',
              action_id: 'candidate',
              placeholder: { type: 'plain_text', text: 'Choose a candidate' },
              options,
            },
          },
          {
            type: 'input',
            block_id: 'feedback_block',
            label: { type: 'plain_text', text: 'Feedback' },
            element: {
              type: 'plain_text_input',
              action_id: 'feedback',
              multiline: true,
            },
          },
        ],
      },
    });
  } catch (err) {
    logger.error(err);
    await fail({ error: 'Something went wrong opening the feedback form.' });
  }
});

// 2) The client submits the modal. Create the Note, then complete the step
//    explicitly using the function execution ID carried in private_metadata.
app.view(MODAL_CALLBACK, async ({ ack, body, view, client, logger }) => {
  await ack(); // closes the modal

  const { channelId, functionExecutionId } = JSON.parse(view.private_metadata || '{}');
  const v = view.state.values;
  const selected = v.candidate_block.candidate.selected_option;
  const applicationId = selected.value;
  const candidateName = selected.text.text;
  const feedback = v.feedback_block.feedback.value;

  // Resolve the name of the person who ran the workflow (the modal submitter).
  // External Connect users may not be fully resolvable, so fall back gracefully.
  let submitterName = (body.user && (body.user.username || body.user.name)) || 'a client';
  try {
    const info = await client.users.info({ user: body.user.id });
    const profile = info.user && info.user.profile;
    submitterName =
      (profile && (profile.display_name || profile.real_name)) ||
      info.user.real_name ||
      submitterName;
  } catch (e) {
    // keep the fallback
  }

  const description = `${feedback}\n\nSubmitted by ${submitterName} via Slack`;

  try {
    const res = await fetch(`${SFUTILITIES_URL}/sf/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId, description }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (functionExecutionId) {
        await client.functions.completeError({
          function_execution_id: functionExecutionId,
          error: (data && data.error) || 'Could not save the note to Seven20.',
        });
      }
      return;
    }

    const summary = `*Client feedback on ${candidateName}* (from ${submitterName})\n${feedback}`;
    if (functionExecutionId) {
      await client.functions.completeSuccess({
        function_execution_id: functionExecutionId,
        outputs: {
          candidate_name: candidateName,
          feedback,
          summary,
          note_id: data.noteId || '',
        },
      });
    }
  } catch (err) {
    logger.error(err);
    if (functionExecutionId) {
      await client.functions.completeError({
        function_execution_id: functionExecutionId,
        error: 'Something went wrong saving the feedback.',
      });
    }
  }
});

(async () => {
  await app.start();
  console.log('SwingSearch Client Feedback app running (Socket Mode)');
})();
