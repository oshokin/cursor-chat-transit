import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_SUPPORT,
  visualizationFilenamesFromChat,
} from '../src/artifact-support';

test('visualizations require structured Cursor tool params', () => {
  const name = 'sales-chart.html';

  const names = visualizationFilenamesFromChat(
    JSON.stringify({
      text: `visualizations/${name}`,
      arbitrary: `visualizations/${name}`,
      toolCall: {
        params: { relativeWorkspacePath: `visualizations/${name}` },
      },
    }),
    [
      {
        value: JSON.stringify({
          rawText: `/tmp/visualizations/${name}`,
          toolCall: {
            params: { targetFile: `/store/visualizations/other.html` },
          },
        }),
      },
    ],
  );

  assert.deepEqual(names.sort(), ['other.html', name]);
});

test('visualizations reject arbitrary paths and unsafe basenames', () => {
  assert.deepEqual(
    visualizationFilenamesFromChat(
      JSON.stringify({
        params: { targetFile: '/tmp/not-visualizations/chart.html' },
        nested: {
          params: { targetFile: '/tmp/visualizations/../escape.html' },
        },
      }),
      [],
    ),
    [],
  );
});

test('terminal and transcript artifacts have explicit unsupported status', () => {
  assert.equal(ARTIFACT_SUPPORT.visualization.status, 'degraded');
  assert.equal(ARTIFACT_SUPPORT.terminal.status, 'unsupported');
  assert.equal(ARTIFACT_SUPPORT.transcript.status, 'unsupported');
  assert.match(ARTIFACT_SUPPORT.terminal.reason || '', /stable chat-owned/i);
});
