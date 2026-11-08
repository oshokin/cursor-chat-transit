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

test('terminal and transcript artifacts have explicit historical support status', () => {
  assert.equal(ARTIFACT_SUPPORT.visualization.status, 'supported');
  assert.equal(ARTIFACT_SUPPORT.terminal.status, 'supported');
  assert.equal(ARTIFACT_SUPPORT.transcript.status, 'supported');

  assert.match(
    ARTIFACT_SUPPORT.terminal.reason || '',
    /historical attachments/i,
  );

  assert.match(
    ARTIFACT_SUPPORT.transcript.reason || '',
    /legacy, canonical and nested/i,
  );
});

test('renderer visualization src references are typed, bounded, and deduplicated', () => {
  assert.deepEqual(
    visualizationFilenamesFromChat(
      JSON.stringify({
        references: [
          { kind: 'visualization', src: ' chart.html ' },
          {
            attribs: {
              kind: 'visualization',
              src: 'visualizations/chart.html',
            },
          },
          { properties: { kind: 'visualization', src: 'chart.html' } },
          { kind: 'visualization', src: '/tmp/visualizations/private.html' },
          { kind: 'visualization', src: '../escape.html' },
          { type: 'visualization', src: 'not-the-discriminator.html' },
          { type: 'image', src: 'image.html' },
          { src: 'arbitrary.html' },
        ],
        text: 'visualizations/mentioned.html',
      }),
      [],
    ),
    ['chart.html'],
  );
});
