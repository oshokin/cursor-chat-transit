import { SqliteSession, superviseSqlite } from '../../src/sqlite-session';
import { guardSqliteParent } from '../../src/sqlite-orphan-guard';

superviseSqlite();
const guard = guardSqliteParent();

void (async () => {
  const session = await SqliteSession.open({
    database: process.argv[2]!,
    timeoutMs: 100,
  });

  await session.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES('uncommitted');");
  process.send?.({ type: 'entered' });

  await session.exec(
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;',
  );

  await session.close();
  guard.kill();
})().catch((error) => {
  guard.kill();
  process.send?.({ type: 'failure', message: String(error) });
  process.exitCode = 1;
});
