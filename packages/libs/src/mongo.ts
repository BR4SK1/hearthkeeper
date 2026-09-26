import { MongoClient, type Db } from "mongodb";

/**
 * Process-wide Mongo connection singleton. The client is created lazily
 * (MongoClient does not connect until first operation) and cached per URI so
 * repeated calls within a process reuse one connection pool.
 */
let client: MongoClient | null = null;
let clientUri: string | null = null;

export async function getMongoClient(uri: string): Promise<MongoClient> {
  if (client && clientUri === uri) {
    return client;
  }
  // If the URI changed (unlikely; only tests do this), close the old pool first.
  if (client) {
    await client.close();
  }
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  clientUri = uri;
  return client;
}

export async function getDb(uri: string, dbName: string): Promise<Db> {
  const mongoClient = await getMongoClient(uri);
  return mongoClient.db(dbName);
}

/**
 * Liveness probe: issues a ping command within the given timeout. Never
 * throws — callers use the boolean to decide what to report (e.g. /health).
 */
export async function pingMongo(uri: string, timeoutMs = 300): Promise<boolean> {
  let probeClient: MongoClient | null = null;
  try {
    // A dedicated short-timeout client keeps ping latency tight and avoids
    // disturbing the main pool's server selection.
    probeClient = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs });
    await probeClient.db().command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    if (probeClient) {
      await probeClient.close();
    }
  }
}

/** Idempotent shutdown: safe to call twice; the second call is a no-op. */
export async function closeMongo(): Promise<void> {
  if (!client) {
    return;
  }
  const closing = client;
  client = null;
  clientUri = null;
  await closing.close();
}
