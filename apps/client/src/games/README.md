# CraftYap games

The interactive game modes are kept separate from the editorial homepage. The
homepage lives in `src/home`; open the game hub with `/?play=1`, or deep-link
to a mode with `/?mode=tower`, `/?mode=builder`, `/?mode=craft`, or
`/?mode=battle`.

Game runtime modules remain in their existing domain folders for now so their
imports and E2E coverage stay stable while the content site evolves.
