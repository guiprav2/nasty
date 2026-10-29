// Native handles behind MediaStreamTrack objects, kept out of the public objects.
// Entries are { handle, remote } for capture sources and received tracks.
export const mediaTrackSources = new WeakMap();
