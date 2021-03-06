/* eslint-disable no-console */
'use strict';

const assert = require('assert');

const defaults = require('../../../lib/defaults');
const { isFirefox } = require('../../../lib/guessbrowser');
const { createRoom, completeRoom } = require('../../../lib/rest');
const getToken = require('../../../lib/token');

const {
  randomName,
  waitToGoOffline,
  waitToGoOnline,
  smallVideoConstraints,
  waitFor
} = require('../../../lib/util');

const DockerProxyClient = require('../../../../docker/dockerProxyClient');
const { connect, createLocalTracks } = require('../../../../lib');

const {
  MediaConnectionError,
  SignalingConnectionDisconnectedError
} = require('../../../../lib/util/twilio-video-errors');

const ONE_MINUTE = 60 * 1000;
const VALIDATE_MEDIA_FLOW_TIMEOUT = ONE_MINUTE;
const RECONNECTING_TIMEOUT = 5 * ONE_MINUTE;
const RECONNECTED_TIMEOUT = 5 * ONE_MINUTE;
const DISCONNECTED_TIMEOUT = 10 * ONE_MINUTE;

// resolves when room received n track started events.
function waitForTracksToStart(room, n) {
  return new Promise(resolve => {
    room.on('trackStarted', function trackStarted() {
      if (--n <= 0) {
        room.removeListener('trackStarted', trackStarted);
        resolve();
      }
    });
  });
}

/**
 * Set up a Room for the given number of people.
 * @param {number} nPeople - Number of people
 * @param {object} extraOptions - Extra options for the first Participant.
 * @returns {Promise<Array<Room>>}
 */
async function setup(nPeople, extraOptions = {}) {
  const name = randomName();
  const people = ['Alice', 'Bob', 'Charlie', 'Mak'].slice(0, nPeople);
  console.log(`Setting up for ${nPeople} Participants`);
  const sid = await createRoom(name, defaults.topology);

  return waitFor(people.map(async (userName, i) => {
    const constraints = { audio: true, video: smallVideoConstraints, fake: true };
    const tracks = await waitFor(createLocalTracks(constraints), `${userName}: creating LocalTracks`);
    const options = Object.assign({ name: sid, tracks }, i === 0 ? extraOptions : {}, defaults);
    const room = await connect(getToken(userName), options);

    const roomStr = `${room.localParticipant.identity}:${room.sid}`;
    // eslint-disable-next-line no-warning-comments
    console.log(`Connected to Room: ${roomStr}`);
    room.on('disconnected', () => console.log(`Disconnected from Room: ${roomStr}`));
    room.on('reconnecting', () => console.log(`Reconnecting to Room: ${roomStr}`));
    room.on('reconnected', () => console.log(`Reconnected to Room: ${roomStr}`));
    room.on('trackStarted', () => console.log(`"trackStarted" emitted by Room: ${roomStr}`));
    room.on('participantConnected', () => console.log(roomStr + ': room received participantConnected'));

    const { iceServers, iceTransportPolicy } = extraOptions;

    const shouldWaitForTracksToStart = nPeople > 1 && (
      iceTransportPolicy !== 'relay'
      || !Array.isArray(iceServers)
      || iceServers.length > 0);

    if (shouldWaitForTracksToStart) {
      const trackStartsExpected = (nPeople - 1) * 2;
      await waitFor(waitForTracksToStart(room, trackStartsExpected), `${roomStr}:${trackStartsExpected} Tracks to start`);
    }
    return room;
  }), 'Rooms to get connected, and Tracks started');
}

function getTotalBytesReceived(statReports) {
  let totalBytesReceived = 0;
  statReports.forEach(statReport => {
    ['remoteVideoTrackStats', 'remoteAudioTrackStats'].forEach(trackType => {
      statReport[trackType].forEach(trackStats => {
        totalBytesReceived += trackStats.bytesReceived;
      });
    });
  });
  return totalBytesReceived;
}

// validates that media was flowing in given rooms.
async function validateMediaFlow(room) {
  const testTimeMS = 6000;
  // wait for some time.
  await new Promise(resolve => setTimeout(resolve, testTimeMS));

  // get StatsReports.
  const statsBefore = await room.getStats();
  const bytesReceivedBefore = getTotalBytesReceived(statsBefore);

  // wait for some more time.
  await new Promise(resolve => setTimeout(resolve, testTimeMS));

  const statsAfter = await room.getStats();
  const bytesReceivedAfter = getTotalBytesReceived(statsAfter);
  console.log(`Total bytes Received in ${room.localParticipant.identity}'s Room: ${bytesReceivedBefore} => ${bytesReceivedAfter}`);
  if (bytesReceivedAfter <= bytesReceivedBefore) {
    throw new Error('no media flow detected');
  }
}

// reads and prints list of current networks.
// returns currentNetworks array.
async function readCurrentNetworks(dockerAPI) {
  const currentNetworks = await waitFor(dockerAPI.getCurrentNetworks(), 'getCurrentNetworks');
  console.log('currentNetworks: ', currentNetworks);
  return currentNetworks;
}

describe('Reconnection states and events', function() {
  // eslint-disable-next-line no-invalid-this
  this.timeout(8 * ONE_MINUTE);

  let dockerAPI = new DockerProxyClient();
  let isRunningInsideDocker = false;
  before(async () => {
    isRunningInsideDocker = await dockerAPI.isDocker();
    console.log('isRunningInsideDocker = ', isRunningInsideDocker);
  });

  it('DockerProxyClient can determine if running inside docker', () => {
    // We skip docker dependent tests when not running inside docker.
    // this test is included mainly to ensure that not all tests in this file
    // are skipped. karma returns failures if all tests in a file were skipped :)
    assert.equal(typeof isRunningInsideDocker, 'boolean');
  });

  it('can detect media flow', async () => {
    const rooms =  await setup(2);
    await waitFor(rooms.map(validateMediaFlow), 'validate media flow', VALIDATE_MEDIA_FLOW_TIMEOUT);
    rooms.forEach(room => room.disconnect());
    return completeRoom(rooms[0].sid);
  });

  [1, 2].forEach(nPeople => {
    describe(`${nPeople} Participant(s)`, () => {
      let rooms = [];
      let currentNetworks = null;

      beforeEach(async function() {
        // eslint-disable-next-line no-invalid-this
        console.log('Starting: ' + this.test.fullTitle());

        if (!isRunningInsideDocker) {
          // eslint-disable-next-line no-invalid-this
          this.skip();
        } else {
          await waitFor(dockerAPI.resetNetwork(), 'reset network');
          await waitToGoOnline();
          currentNetworks = await readCurrentNetworks(dockerAPI);
          rooms = await waitFor(setup(nPeople), 'setup Rooms');
        }
      });

      afterEach(async () => {
        if (isRunningInsideDocker) {
          const sid = rooms[0].sid;
          rooms.forEach(room => room.disconnect());
          rooms = [];
          await waitFor(dockerAPI.resetNetwork(), 'reset network after each');
          await completeRoom(sid);
        }
      });

      describe('Network interruption', () => {
        let disconnectedPromises;
        let localParticipantDisconnectedPromises;
        let localParticipantReconnectedPromises;
        let localParticipantReconnectingPromises;
        let reconnectedPromises;
        let reconnectingPromises;

        beforeEach(async () => {
          if (isRunningInsideDocker) {
            disconnectedPromises = rooms.map(room => new Promise(resolve => room.once('disconnected', resolve)));
            localParticipantDisconnectedPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('disconnected', resolve)));
            localParticipantReconnectedPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnected', resolve)));
            localParticipantReconnectingPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnecting', resolve)));
            reconnectedPromises = rooms.map(room => new Promise(resolve => room.once('reconnected', resolve)));
            reconnectingPromises = rooms.map(room => new Promise(resolve => room.once('reconnecting', resolve)));
            await waitFor(currentNetworks.map(({ Id: networkId }) => dockerAPI.disconnectFromNetwork(networkId)), 'disconnect from all networks');
            await waitToGoOffline();
          }
        });

        it('should emit "reconnecting" on the Rooms and LocalParticipants', () => {
          return Promise.all([
            waitFor(localParticipantReconnectingPromises, 'localParticipantReconnectingPromises', RECONNECTING_TIMEOUT),
            waitFor(reconnectingPromises, 'reconnectingPromises', RECONNECTING_TIMEOUT)
          ]);
        });

        context('that is longer than the session timeout', () => {
          it('should emit "disconnected" on the Rooms and LocalParticipants' + isFirefox ? ' @unstable ' : '', async () => {
            await Promise.all([
              waitFor(localParticipantReconnectingPromises, 'localParticipantReconnectingPromises', RECONNECTING_TIMEOUT),
              waitFor(reconnectingPromises, 'reconnectingPromises', RECONNECTING_TIMEOUT)
            ]);
            return Promise.all([
              waitFor(localParticipantDisconnectedPromises, 'localParticipantDisconnectedPromises', DISCONNECTED_TIMEOUT),
              waitFor(disconnectedPromises, 'disconnectedPromises', DISCONNECTED_TIMEOUT)
            ]);
          });
        });

        context('that recovers before the session timeout', () => {
          it('should emit "reconnected" on the Rooms and LocalParticipants' + isFirefox ? ' @unstable ' : '', async () => {
            await Promise.all([
              waitFor(localParticipantReconnectingPromises, 'localParticipantReconnectingPromises', RECONNECTING_TIMEOUT),
              waitFor(reconnectingPromises, 'reconnectingPromises', RECONNECTING_TIMEOUT)
            ]);
            await waitFor(currentNetworks.map(({ Id: networkId }) => dockerAPI.connectToNetwork(networkId)), 'reconnect to original networks');
            await readCurrentNetworks(dockerAPI);
            await waitToGoOnline();

            try {
              await Promise.all([
                waitFor(localParticipantReconnectedPromises, 'localParticipantReconnectedPromises', RECONNECTED_TIMEOUT),
                waitFor(reconnectedPromises, 'reconnectedPromises', RECONNECTED_TIMEOUT)
              ]);
            } catch (err) {
              console.log('rooms - Failed to Reconnect:');
              rooms.forEach(room => console.log(`ConnectionStates: ${room.localParticipant.identity}: signalingConnectionState:${room._signaling.signalingConnectionState}  iceConnectionState:${room._signaling.iceConnectionState}`));
              console.log('rooms - Failed to Reconnect Hope that helps');
              throw err;
            }

            if (nPeople > 1) {
              // if mroe than one person have joined room
              // validate the media flow.
              try {
                await waitFor(rooms.map(validateMediaFlow), 'validate media flow', VALIDATE_MEDIA_FLOW_TIMEOUT);
              } catch (_err) {
                console.log('TODO(mpatwardhan) : no media detected in the room. But ignoring that for now.');
              }
            }
          });
        });
      });

      // NOTE: network handoff does not work Firefox because of following known issues
      // ([bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1546562))
      // ([bug](https://bugzilla.mozilla.org/show_bug.cgi?id=1548318))
      (isFirefox ? describe.skip : describe)('Network handoff reconnects to new network', () => {
        it('@unstable: Scenario 1 (jump): connected interface switches off and then a new interface switches on',  async () => {
          const localParticipantReconnectedPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnected', resolve)));
          const localParticipantReconnectingPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnecting', resolve)));
          const reconnectingPromises = rooms.map(room => new Promise(resolve => room.once('reconnecting', resolve)));
          const reconnectedPromises = rooms.map(room => new Promise(resolve => room.once('reconnected', resolve)));
          const newNetwork = await waitFor(dockerAPI.createNetwork(), 'create network');

          await waitFor(currentNetworks.map(({ Id: networkId }) => dockerAPI.disconnectFromNetwork(networkId)), 'disconnect from networks');
          await waitFor(dockerAPI.connectToNetwork(newNetwork.Id), 'connect to network');
          await readCurrentNetworks(dockerAPI);

          try {
            await Promise.all([
              waitFor(localParticipantReconnectingPromises, 'localParticipantReconnectingPromises', RECONNECTING_TIMEOUT),
              waitFor(reconnectingPromises, 'reconnectingPromises', RECONNECTING_TIMEOUT)
            ]);
            await Promise.all([
              waitFor(localParticipantReconnectedPromises, 'localParticipantReconnectedPromises', RECONNECTED_TIMEOUT),
              waitFor(reconnectedPromises, 'reconnectedPromises', RECONNECTED_TIMEOUT)
            ]);
          } catch (err) {
            console.log('rooms - Failed to Reconnect. Checking status:');
            rooms.forEach(room => console.log(`ConnectionStates: ${room.localParticipant.identity}: signalingConnectionState:${room._signaling.signalingConnectionState}  iceConnectionState:${room._signaling.iceConnectionState}`));
            console.log('rooms - Failed to Reconnect Hope that helps');
            throw err;
          }

          if (nPeople > 1) {
            await waitFor(rooms.map(validateMediaFlow), 'validate media flow', VALIDATE_MEDIA_FLOW_TIMEOUT);
          }
        });

        it('@unstable: Scenario 2 (step) : new interface switches on and then the connected interface switches off.', async () => {
          const localParticipantReconnectedPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnected', resolve)));
          const localParticipantReconnectingPromises = rooms.map(({ localParticipant }) => new Promise(resolve => localParticipant.once('reconnecting', resolve)));
          const reconnectingPromises = rooms.map(room => new Promise(resolve => room.once('reconnecting', resolve)));
          const reconnectedPromises = rooms.map(room => new Promise(resolve => room.once('reconnected', resolve)));

          // create and connect to new network
          const newNetwork = await waitFor(dockerAPI.createNetwork(), 'create network');
          await waitFor(dockerAPI.connectToNetwork(newNetwork.Id), 'connect to network');
          await readCurrentNetworks(dockerAPI);

          // disconnect from current network(s).
          await waitFor(currentNetworks.map(({ Id: networkId }) => dockerAPI.disconnectFromNetwork(networkId)), 'disconnect from network');

          await readCurrentNetworks(dockerAPI);
          await waitToGoOnline();

          try {
            await Promise.all([
              waitFor(localParticipantReconnectingPromises, 'localParticipantReconnectingPromises', RECONNECTING_TIMEOUT),
              waitFor(reconnectingPromises, 'reconnectingPromises', RECONNECTING_TIMEOUT)
            ]);
            await Promise.all([
              waitFor(localParticipantReconnectedPromises, 'localParticipantReconnectedPromises', RECONNECTED_TIMEOUT),
              waitFor(reconnectedPromises, 'reconnectedPromises', RECONNECTED_TIMEOUT)
            ]);
          } catch (err) {
            console.log('rooms - Failed to Reconnect. Checking status:');
            rooms.forEach(room => console.log(`ConnectionStates: ${room.localParticipant.identity}: signalingConnectionState:${room._signaling.signalingConnectionState}  iceConnectionState:${room._signaling.iceConnectionState}`));
            console.log('rooms - Failed to Reconnect Hope that helps');
            throw err;
          }

          if (nPeople > 1) {
            await waitFor(rooms.map(validateMediaFlow), 'validate media flow', VALIDATE_MEDIA_FLOW_TIMEOUT);
          }
        });
      });

      (nPeople > 1 ? describe : describe.skip)('RemoteParticipant reconnection events', () => {
        it('should emit "reconnecting" and "reconnected" events on the RemoteParticipant which recovers from signaling connection disruption (@unstable: JSDK-2695) ', async () => {
          const [aliceRoom, bobRoom] = rooms;
          const aliceRemote = bobRoom.participants.get(aliceRoom.localParticipant.sid);

          const eventPromises = new Promise(resolve => {
            const eventsEmitted = [];
            const resolveIfAllEventsFired = () => eventsEmitted.length === 8 && resolve(eventsEmitted);

            aliceRoom.localParticipant.on('reconnecting', () => {
              eventsEmitted.push({ event: 'LocalParticipant#reconnecting' });
              resolveIfAllEventsFired();
            });

            aliceRoom.localParticipant.on('reconnected', () => {
              eventsEmitted.push({ event: 'LocalParticipant#reconnected' });
              resolveIfAllEventsFired();
            });

            aliceRoom.on('reconnecting', error => {
              eventsEmitted.push({ event: 'LocalRoom#reconnecting', error });
              resolveIfAllEventsFired();
            });

            aliceRoom.on('reconnected', () => {
              eventsEmitted.push({ event: 'LocalRoom#reconnected' });
              resolveIfAllEventsFired();
            });

            aliceRemote.on('reconnecting', () => {
              eventsEmitted.push({ event: 'RemoteParticipant#reconnecting' });
              resolveIfAllEventsFired();
            });

            aliceRemote.on('reconnected', () => {
              eventsEmitted.push({ event: 'RemoteParticipant#reconnected' });
              resolveIfAllEventsFired();
            });

            bobRoom.on('participantReconnecting', participant => {
              eventsEmitted.push({ event: 'RemoteRoom#participantReconnecting', participant });
              resolveIfAllEventsFired();
            });

            bobRoom.on('participantReconnected', participant => {
              eventsEmitted.push({ event: 'RemoteRoom#participantReconnected', participant });
              resolveIfAllEventsFired();
            });
          });

          // NOTE(mmalavalli): Simulate a signaling connection interruption by
          // closing Alice's WebSocket transport. Then, wait until all the expected
          // events are fired.
          aliceRoom._signaling._transport._twilioConnection._close({ code: 3005, reason: 'foo' });
          const eventsEmitted = await eventPromises;

          assert.equal(eventsEmitted.length, 8);
          eventsEmitted.forEach(item => {
            switch (item.event) {
              case 'LocalRoom#reconnecting':
                assert(item.error instanceof SignalingConnectionDisconnectedError);
                break;
              case 'RemoteRoom#participantReconnecting':
              case 'RemoteRoom#participantReconnected':
                assert.equal(item.participant, aliceRemote);
                break;
            }
          });
        });
      });
    });
  });

  describe('ICE gathering timeout', () => {
    let room;

    before(async function() {
      if (!isRunningInsideDocker) {
        // eslint-disable-next-line no-invalid-this
        this.skip();
      } else {
        // NOTE(mmalavalli): We can simulate ICE gathering timeout by forcing TURN
        // relay and passing an empty RTCIceServers[]. This way, no relay candidates
        // are gathered, and should force an ICE gathering timeout.
        [room] = await waitFor(setup(defaults.topology === 'peer-to-peer' ? 2 : 1, {
          iceServers: [],
          iceTransportPolicy: 'relay'
        }), 'Room setup');
      }
    });

    it('should transition Room .state to "reconnecting" for the first timeout', async () => {
      if (room.state !== 'reconnecting') {
        const reconnectingPromise = new Promise(resolve => room.once('reconnecting', error => resolve(error)));
        const error = await waitFor(reconnectingPromise, 'Room#reconnecting');
        assert(error instanceof MediaConnectionError);
      }
    });

    it('should eventually transition Room .state to "disconnected"', async () => {
      if (room.state !== 'disconnected') {
        const disconnectedPromise = new Promise(resolve => room.once('disconnected', (room, error) => resolve(error)));
        const error = await waitFor(disconnectedPromise, 'Room#disconnected');
        assert(error instanceof MediaConnectionError);
      }
    });

    after(async () => {
      if (isRunningInsideDocker && room) {
        room.disconnect();
        await completeRoom(room.sid);
      }
    });
  });
});
