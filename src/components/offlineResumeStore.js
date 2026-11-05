// Local partial bytes only; never persist access tokens. Server expiry is authoritative.
let database;
const LEASE_MS = 120000;

function db() {
    if (!database) {
        database = new Promise((resolve, reject) => {
            const request = indexedDB.open('jellyfin-offline-resume-v2', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('records', { keyPath: 'key' });
                request.result.createObjectStore('chunks', { keyPath: ['key', 'offset'] });
                request.result.createObjectStore('leases', { keyPath: 'key' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('Browser storage is unavailable; resumable downloads need IndexedDB.'));
            request.onblocked = () => reject(new Error('Close other Jellyfin tabs and retry browser storage.'));
        });
    }
    return database;
}

async function run(stores, mode, action) {
    const connection = await db();
    return new Promise((resolve, reject) => {
        const transaction = connection.transaction(stores, mode);
        let result;
        let failure;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(failure || new Error('Browser storage failed or its quota was reached. Your last saved partial download is retained.'));
        const fail = (message) => {
            failure = new Error(message);
            transaction.abort();
        };
        action(transaction, (value) => {
            result = value;
        }, fail);
    });
}

const range = (key) => IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);

export async function acquire(key, owner) {
    return run(['leases'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('leases');
        const request = store.get(key);
        request.onsuccess = () => {
            if (request.result && request.result.owner !== owner && request.result.until > Date.now()) {
                fail('This download is already open in another tab. Pause it there first.');
                return;
            }
            store.put({ key, owner, until: Date.now() + LEASE_MS });
            done(true);
        };
    });
}

export async function renew(key, owner) {
    return run(['leases'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('leases');
        const request = store.get(key);
        request.onsuccess = () => {
            if (!request.result || request.result.owner !== owner) {
                fail('This download was resumed in another tab. This tab will stop without overwriting it.');
                return;
            }
            store.put({ key, owner, until: Date.now() + LEASE_MS });
            done(true);
        };
    });
}

export async function release(key, owner) {
    return run(['leases'], 'readwrite', (tx) => {
        const store = tx.objectStore('leases');
        const request = store.get(key);
        request.onsuccess = () => {
            if (request.result?.owner === owner) store.delete(key);
        };
    });
}

export async function get(key) {
    return run(['records'], 'readonly', (tx, done) => {
        const request = tx.objectStore('records').get(key);
        request.onsuccess = () => done(request.result);
    });
}

export async function put(record, owner) {
    return run(['records', 'leases'], 'readwrite', (tx, done, fail) => {
        const lease = tx.objectStore('leases').get(record.key);
        lease.onsuccess = () => {
            if (lease.result?.owner !== owner) {
                fail('Download ownership changed to another tab.');
                return;
            }
            tx.objectStore('records').put(record);
            done(true);
        };
    });
}

export async function append(record, bytes, owner) {
    return run(['records', 'chunks', 'leases'], 'readwrite', (tx, done, fail) => {
        const lease = tx.objectStore('leases').get(record.key);
        lease.onsuccess = () => {
            if (lease.result?.owner !== owner) {
                fail('Download ownership changed to another tab.');
                return;
            }
            const request = tx.objectStore('records').get(record.key);
            request.onsuccess = () => {
                const current = request.result;
                if (!current || current.offset !== record.offset || current.etag !== record.etag) {
                    fail('The partial download changed. Resume it from its current tab.');
                    return;
                }
                const next = { ...current, offset: current.offset + bytes.byteLength };
                tx.objectStore('chunks').put({ key: record.key, offset: current.offset, bytes });
                tx.objectStore('records').put(next);
                done(next);
            };
        };
    });
}

export async function blob(record) {
    return run(['chunks'], 'readonly', (tx, done, fail) => {
        const request = tx.objectStore('chunks').getAll(range(record.key));
        request.onsuccess = () => {
            let offset = 0;
            const buffers = [];
            for (const chunk of request.result) {
                if (chunk.offset !== offset) {
                    fail('The saved partial download has a gap; discard it before retrying.');
                    return;
                }
                offset += chunk.bytes.byteLength;
                buffers.push(chunk.bytes);
            }
            if (offset !== record.size) {
                fail('The saved download is incomplete.');
                return;
            }
            done(new Blob(buffers, { type: 'video/mp4' }));
        };
    });
}

export async function drop(key) {
    return run(['records', 'chunks'], 'readwrite', (tx) => {
        tx.objectStore('records').delete(key);
        tx.objectStore('chunks').delete(range(key));
    });
}

export async function prune() {
    const records = await run(['records'], 'readonly', (tx, done) => {
        const request = tx.objectStore('records').getAll();
        request.onsuccess = () => done(request.result);
    });
    for (const record of records) {
        // A closed browser cannot run a timer: local expired bytes are purged on the next visit.
        if (record.expiresAt <= Date.now()) await drop(record.key);
    }
}
