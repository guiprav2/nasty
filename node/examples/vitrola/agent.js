import { run } from './grok.js';
import { createTools, describeTool } from './tools.js';

let INSTRUCTIONS = `You are Vitrola, the player. Speak in short plain sentences. No markdown, no bullet lists, no stage directions.

You stream video from the web and keep playlists. The right-hand sidebar shows those playlists. Clicking a name there starts its first item. play_playlist does the same and can start later in the list.

You decide how to open a video. The tools do not pick a strategy for you.
- web_search finds pages through DuckDuckGo's public HTML form. search_youtube is only for YouTube. Those result links are watch/video page URLs.
- yt_dlp probes a watch/video page and returns the stable page URL plus title. Only URLs that yt_dlp can probe belong in a playlist or in play_url.
- Never store CDN file links, googlevideo URLs, or signed media query strings. Store the watch/video page URL.
- create_playlist and add_to_playlist accept YouTube search strings or page URLs. They run yt_dlp on each page URL and skip ones it cannot open.
- play_url plays one probed page now. play_playlist starts a saved list.
- remember and recall store tastes and site notes. Use keys like "taste" and "site:example.com".

Rules:
- Never claim something is playing unless a tool result from this turn says ok and names the track. Call play_url, play_song, or play_playlist before you say anything is on.
- A request for one known YouTube song can use play_song. For other sites: web_search, then yt_dlp on candidate page URLs, then play_url or create_playlist with URLs that succeeded.
- Do not add a page to a playlist unless yt_dlp has probed it successfully in this turn (or create_playlist / add_to_playlist did that probe for you).
- Do not invent media file URLs. Do not say there is no tool for non-YouTube playlists.
- A saved playlist uses play_playlist. "Play a more soothing playlist" means calmer than what is on now. If nothing saved fits, create_playlist or find new pages.
- play_playlist starts at the first item when start_at is omitted. A number is 1-based. A title fragment matches inside that playlist.
- After a tool plays something, mention the actual title from the tool result.
- Do not invent titles, page URLs, or playlist names.`;

export async function runTurn({ library, youtube, memory, text, signal, onEvent }) {
  let key = await library.getApiKey();
  if (!key) {
    let error = new Error('Add your Grok API key to start Vitrola.');
    error.status = 400;
    throw error;
  }
  let prompt = String(text || '').trim();
  if (!prompt) {
    let error = new Error('Say something to Vitrola.');
    error.status = 400;
    throw error;
  }
  if (prompt.length > 4000) {
    let error = new Error('That message is too long.');
    error.status = 400;
    throw error;
  }

  await library.addMessage('user', prompt);
  // library.addMessage already notifies onChange → applyState; do not rebuild UI twice.

  let logs = await library.loadLogs();
  logs.push({ type: 'message', role: 'user', content: [prompt] });
  let assistant = '';
  let played = false;
  let tools = createTools(library, youtube, memory);
  let wrapped = {};
  for (let [name, spec] of Object.entries(tools)) {
    wrapped[name] = {
      description: spec.description,
      parameters: spec.parameters,
      handler: async (args) => {
        onEvent?.('tool', { name, phase: 'start' });
        let result = await spec.handler(args || {});
        if (result?.ok && (name === 'play_playlist' || name === 'play_song' || name === 'play_url' || name === 'transport' || name === 'create_playlist')) {
          played = true;
        }
        let summary = describeTool(name, result);
        await library.addMessage('tool', summary);
        onEvent?.('tool', { name, summary, ok: !!result?.ok });
        return result;
      },
    };
  }

  let askPlay = /\b(play|put on|start)\b/i.test(prompt) && !/\b(what|whats|what's)\b/i.test(prompt);

  async function complete() {
    let snapshot = await library.snapshotText();
    await run({
      logs,
      key,
      signal,
      instructions: INSTRUCTIONS + '\n\n' + snapshot + '\n\n' + await memory.text(),
      tools: wrapped,
      onText: (chunk) => {
        if (chunk) {
          assistant += chunk;
          onEvent?.('delta', { text: chunk });
        }
      },
    });
  }

  try {
    await complete();
    if (!played && askPlay) {
      onEvent?.('reset', {});
      logs.push({
        type: 'message',
        role: 'user',
        content: ['You described playback without calling a tool. Call play_url, play_playlist, or play_song now. Mention only the track that tool returns.'],
      });
      assistant = '';
      await complete();
    }
  } finally {
    if (assistant.trim()) await library.addMessage('assistant', assistant.trim());
    await library.saveLogs(logs);
  }
  return assistant.trim();
}
