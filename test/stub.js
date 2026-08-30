/* Test harness for the "numbers handed out" work.

   Stands in for the Vercel API with scripted data, so every rendering path can
   be driven — paused, expired, offline, two holders on one house, a house this
   phone has never seen — without a single write to the live territory.

   Scenario is chosen by ?sc= on the URL. window.TM lets the driver mutate the
   scripted state between assertions. */
(function () {
  var qs = new URLSearchParams(location.search);
  var sc = qs.get('sc') || 'owner';

  /* h1 has two visits, h2 has five (so the row shows the last four and the
     subtitle counts them), h6 was retired years ago and is due for review. */
  var SEED = {
    h1: JSON.stringify([
      { i: 'e1', d: '2026-08-01', t: 'Not home', k: 'NH', u: 'u1' },
      { i: 'e2', d: '2026-08-10', t: 'Woman — took a magazine', k: 'W', u: 'u2' }]),
    h2: JSON.stringify([1,2,3,4,5].map(function (i) {
      return { i: 'f' + i, d: '2026-08-0' + i, t: 'Visit ' + i, k: i % 2 ? 'NH' : 'BZ', u: 'u1' }; })),
    h6: JSON.stringify([
      { i: 'd1', d: '2023-01-15', t: 'Do not visit — asked us not to call again',
        k: 'DNV', r: 'asked us not to call again', u: 'u1' }]),
  };
  /* Dos revisitas que el codigo nuevo tiene que saber leer: una escrita antes
     de que existieran los campos (solo n), y una cuya cita ya se paso. */
  var RVS = {
    h8: JSON.stringify([
      { i: 'old1', d: '2026-07-14', n: 'Se quedo con la revista, hablar de la familia', u: 'u1' }]),
    h9: JSON.stringify([
      { i: 'late1', d: '2026-08-02', s: 'Le interesa por que hay tanta maldad',
        rd: '2026-08-16', rt: '09:00', p: 'Leer Salmo 37:10, 11', u: 'u1' }]),
  };
  var HOUSES = [
    ['h1', '6440 Ardilla Rd #1'], ['h2', '6440 Ardilla Rd #2'],
    ['h3', '6900 Atascadero Ave'], ['h4', '6940 Atascadero Ave'],
    ['h5', '7405 Atascadero Ave'], ['h6', '7860 Atascadero Ave'],
    ['h7', '7860 Atascadero Ave #Traila'], ['h8', '6400 Nacimiento Ave #3'],
    ['h9', '8500 Santa Ynez Ave #A'],
  ].map(function (r) {
    return {
      id: r[0], HouseAddress: r[1], HouseCity: 'Atascadero', HouseState: 'CA',
      HouseZIP: '93422', HouseTerritoryNumber: 'Atascadero 3',
      HouseNotes: '', HouseLanguage: '', HouseLastVisitDate: '',
      HouseVisitLog: SEED[r[0]] || '', HouseReturnVisits: RVS[r[0]] || '',
      HouseUpdatedAt: '2026-08-20T10:00:00.000Z',
      // A row written before the visit log existed: history in the old column only.
      HouseResutsOnVisit1: r[0] === 'h4' ? 'Nc' : '',
    };
  });

  var endOfToday = (function () { var d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();

  function packet(o) {
    return {
      id: o.id, territory: o.territory || 'Atascadero 3',
      assigneeId: o.guestCode ? '' : 'u2',
      who: o.who, hasAccount: !o.guestCode, guestCode: o.guestCode || '',
      houseIds: o.houseIds, expiresAt: o.expiresAt === undefined ? endOfToday : o.expiresAt,
    };
  }

  var TM = window.TM = {
    scenario: sc,
    working: true,
    failTeam: false,          // every /api/team call rejects like a dead network
    calls: [],                // every action the app asked for, in order
    colors: { colorAssigned: '#1565C0', colorDnv: '#B42318', colorTalked: '#12805C' },
    packets: [
      packet({ id: 'p1', who: 'Ilmy Barajas', houseIds: ['h1', 'h2', 'h3', 'h4', 'h5'] }),
      packet({ id: 'p2', who: 'Hermano Lopez', guestCode: 'K7RQ2M', houseIds: ['h5', 'h6', 'zz-not-on-this-phone'] }),
    ],
  };

  if (sc === 'expired') {
    TM.packets.push(packet({ id: 'p3', who: 'Ana Ruiz', houseIds: ['h8'], expiresAt: Date.now() - 60000 }));
  }
  if (sc === 'two') {
    HOUSES[7].HouseTerritoryNumber = 'Atascadero 7';
    HOUSES[8].HouseTerritoryNumber = 'Atascadero 7';
    TM.packets.push(packet({ id: 'p9', who: 'Otro Hermano', territory: 'Atascadero 7', houseIds: ['h8', 'h9'] }));
  }
  // The user's actual live state: two packets to one person, one a superset.
  if (sc === 'overlap') {
    TM.packets = [
      packet({ id: 'o1', who: 'Ilmy Barajas', houseIds: ['h1', 'h2', 'h3', 'h4', 'h5'] }),
      packet({ id: 'o2', who: 'Ilmy Barajas', houseIds: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'] }),
    ];
  }
  if (sc === 'paused') TM.working = false;
  if (sc === 'empty') TM.packets = [];
  if (sc === 'coldfail') TM.failTeam = true;
  if (sc === 'nohouses') TM.failHouses = true;   // signed in, but the houses have never synced
  // Signed in fine, but the roster check itself fails: the state where saying
  // "nobody has these" would be a confident lie.
  if (sc === 'nolist') TM.failAssignments = true;

  // ?as=admin|owner|numbers|none picks which kind of person is signed in.
  var AS = qs.get('as') || 'admin';
  var SCOPES = {
    admin:   { kind: 'admin',   territories: ['Atascadero 3'], owned: ['Atascadero 3'], canCreate: true,  canDelete: true,  canHandOut: true,  empty: false, reason: '' },
    owner:   { kind: 'holder',  territories: ['Atascadero 3'], owned: ['Atascadero 3'], canCreate: true,  canDelete: true,  canHandOut: true,  empty: false, reason: '' },
    numbers: { kind: 'numbers', territories: [],               owned: [],               canCreate: false, canDelete: false, canHandOut: false, empty: false, reason: '' },
    none:    { kind: 'none',    territories: [],               owned: [],               canCreate: false, canDelete: false, canHandOut: false, empty: true,  reason: 'Nothing is assigned to you yet.' },
  };
  var USER = { id: 'u1', name: 'Cristobal Barajas', phone: '6506305839',
    role: AS === 'admin' ? 'admin' : 'user', active: true };
  var MATE = { id: 'u2', name: 'Ilmy Barajas', phone: '6504687853', role: 'user', active: true };
  try { localStorage.setItem('tm_token', 'stub-token'); } catch (e) {}
  if (sc === 'guest') {
    try {
      localStorage.setItem('tm_guest', 'stub-guest');
      localStorage.setItem('tm_guest_info', JSON.stringify({
        name: 'Hermano Lopez', from: 'Cristobal Barajas',
        territory: 'Atascadero 3', houseIds: ['h5', 'h6'],
        message: 'Start at the top of the street. The dog at 7860 barks but is friendly.',
        expiresAt: endOfToday,
      }));
    } catch (e) {}
  }

  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200, headers: { 'Content-Type': 'application/json' },
    }));
  }
  var deadNetwork = function () { return Promise.reject(new TypeError('Failed to fetch')); };

  var real = window.fetch.bind(window);
  function listBody(body) {
    return json({
      ok: true,
      working: body.territory ? TM.working : false,
      assignments: TM.packets.filter(function (p) { return !body.territory || p.territory === body.territory; }),
    });
  }
  window.fetch = function (input, init) {
    var url = String((input && input.url) || input || '');
    if (url.indexOf('/api/team') === -1 && url.indexOf('/api/territory') === -1) return real(input, init);

    if (url.indexOf('/api/territory') !== -1) {
      if (TM.failHouses) return deadNetwork();
      var scoped = function () {
        if (sc === 'guest') return HOUSES.filter(function (h) { return ['h5', 'h6'].indexOf(h.id) !== -1; });
        if (AS === 'numbers') return HOUSES.slice(0, 7);
        if (AS === 'none') return [];
        return HOUSES;
      };
      var method = (init && init.method) || 'GET';
      if (method === 'GET') return json(scoped());

      /* The bulk path, shaped like the real one — an array here would empty the
         phone's mirror on the first sync and take every house off the screen. */
      var payload = {};
      try { payload = JSON.parse((init && init.body) || '{}'); } catch (e) {}
      var applied = { created: [], updated: [], deleted: [], missing: [] };
      (payload.updates || []).forEach(function (u) {
        var h = HOUSES.filter(function (x) { return x.id === u.id; })[0];
        if (!h) { applied.missing.push(u.id); return; }
        Object.keys(u).forEach(function (k) { if (k !== 'id' && k !== '_base') h[k] = u[k]; });
        h.HouseUpdatedAt = new Date().toISOString();
        applied.updated.push(u.id);
      });
      (payload.creates || []).forEach(function (c) {
        if (HOUSES.some(function (x) { return x.id === c.id; })) return;
        HOUSES.push(Object.assign({ HouseVisitLog: '', HouseReturnVisits: '' }, c,
          { HouseUpdatedAt: new Date().toISOString() }));
        applied.created.push(c.id);
      });
      (payload.deletes || []).forEach(function (id) {
        HOUSES = HOUSES.filter(function (x) { return x.id !== id; });
        applied.deleted.push(id);
      });
      return json({ ok: true, applied: applied, rejected: TM.rejectAll || [], conflicts: [],
        records: scoped(), serverTime: new Date().toISOString() });
    }

    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    TM.calls.push(body.action);
    if (TM.failTeam) return deadNetwork();

    switch (body.action) {
      case 'status':
        return json({ ok: true, hasUsers: true, me: sc === 'signedout' ? null : USER });
      case 'listTerritories':
        // The real endpoint returns the roster and a scope envelope.
        return json({
          ok: true, me: USER, users: qs.get('solo') ? [USER] : [USER, MATE], scope: SCOPES[AS],
          colors: TM.colors,
          territories: [{ name: 'Atascadero 3', ownerId: 'u1', owner: USER, assigneeIds: ['u2'], working: TM.working },
                        { name: 'Atascadero 7', ownerId: 'u1', owner: USER, assigneeIds: [], working: TM.working }],
        });
      case 'listUsers':
        return json({ ok: true, users: [USER, MATE],
          policy: { nights: TM.nights || 0, tz: 'America/Los_Angeles', options: [0,1,2,6],
            colors: TM.colors, defaultColors: { colorAssigned: '#1565C0', colorDnv: '#B42318', colorTalked: '#12805C' } } });
      case 'territoryHistory':
        return json({
          ok: true,
          territories: [
            { name: 'Atascadero 3', ownerId: 'u1', owner: USER,
              assignedOn: '2026-08-01', hasRecord: true, working: true },
            { name: 'Atascadero 7', ownerId: 'u2', owner: MATE,
              assignedOn: '2026-02-10', hasRecord: true, working: false },
            // Held since before the card existed: no start date at all.
            { name: 'Atascadero 5', ownerId: 'u2', owner: MATE,
              assignedOn: '', hasRecord: false, working: false },
            { name: 'Atascadero 9', ownerId: '', owner: null, assignedOn: '', hasRecord: false, working: false },
          ],
          records: [
            { id: 'r3', territory: 'Atascadero 3', userId: 'u1', who: 'Cristobal Barajas',
              assignedOn: '2026-08-01', returnedOn: '', assignedBy: 'Cristobal Barajas', returnedBy: '', note: '' },
            { id: 'r2', territory: 'Atascadero 7', userId: 'u2', who: 'Ilmy',
              assignedOn: '2026-02-10', returnedOn: '', assignedBy: 'Cristobal Barajas', returnedBy: '', note: '' },
            { id: 'r1', territory: 'Atascadero 3', userId: 'u2', who: "Ilmy O'Brien",
              assignedOn: '2026-05-04', returnedOn: '2026-07-30',
              assignedBy: 'Cristobal Barajas', returnedBy: 'Cristobal Barajas', note: 'finished the whole territory' },
          ],
        });
      case 'returnTerritory':
        TM.returned = body.territory;
        return json({ ok: true, closed: 1 });
      case 'setTerritoryStart':
        TM.startSet = { territory: body.territory, on: body.assignedOn };
        return json({ ok: true, assignedOn: body.assignedOn });
      case 'setPacketMessage':
        TM.message = body.text;
        return json({ ok: true, message: body.text });
      case 'setRowColors':
        TM.colors = Object.assign({}, TM.colors, body.colors || {});
        return json({ ok: true, colors: TM.colors });
      case 'listAssignments':
        if (TM.failAssignments) return deadNetwork();
        if (TM.delayMs) {
          var args = arguments;
          return new Promise(function (res) {
            setTimeout(function () { res(listBody(body)); }, TM.delayMs);
          });
        }
        return json({
          ok: true,
          // Mirrors the real server: the working flag is only meaningful when
          // the request named one territory.
          working: body.territory ? TM.working : false,
          assignments: TM.packets.filter(function (p) {
            return !body.territory || p.territory === body.territory;
          }),
        });
      case 'createAssignment': {
        var id = 'new' + (TM.packets.length + 1);
        var code = body.guestName ? 'ZZ' + (TM.packets.length + 4) + 'QX' : '';
        var rec = {
          id: id, territory: body.territory, ownerId: 'u1',
          assigneeId: body.assigneeId || '', guestName: body.guestName || '',
          guestCode: code,
          houseIds: body.houseIds.join(','),      // the real server returns a STRING here
          createdAt: new Date().toISOString(), expiresAt: String(endOfToday), active: '1',
        };
        TM.packets.push(packet({
          id: id, who: body.guestName || 'Ilmy Barajas', guestCode: code, houseIds: body.houseIds.slice(),
        }));
        TM.working = true;
        return json({ ok: true, assignment: rec, guestCode: code, expiresAt: endOfToday });
      }
      case 'revokeAssignment':
        TM.packets = TM.packets.filter(function (p) { return p.id !== body.id; });
        return json({ ok: true });
      case 'setTerritoryWorking':
        TM.working = !!body.working;
        return json({ ok: true, working: TM.working });
      case 'guestStatus':
        return json({ ok: true, territory: 'Atascadero 3', houseIds: ['h5', 'h6'], expiresAt: endOfToday,
          from: 'Cristobal Barajas', fromPhone: '6506305839',
          message: 'Start at the top of the street. The dog at 7860 barks but is friendly.' });
      case 'myAssignments':
        return json({ ok: true, assignments: AS === 'numbers'
          ? [{ id: 'p1', territory: 'Atascadero 3', houseIds: ['h1','h2','h3','h4','h5','h6','h7'],
               from: 'Cristobal Barajas', expiresAt: endOfToday, usable: true, reason: '' }]
          : [] });
      case 'setReturnPolicy':
        TM.nights = body.nights; return json({ ok: true, nights: body.nights });
      case 'getPresence': case 'fieldPoll':
        return json({ ok: true, people: [], clips: [] });
      default:
        return json({ ok: true });
    }
  };
})();
