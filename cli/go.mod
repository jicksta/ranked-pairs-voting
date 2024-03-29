module github.com/jicksta/ranked-pairs-voting/cli

go 1.17

replace github.com/jicksta/ranked-pairs-voting => ../

replace github.com/jicksta/ranked-pairs-voting/report => ../report

replace github.com/jicksta/ranked-pairs-voting/internal => ../internal

replace github.com/jicksta/ranked-pairs-voting/sys => ../sys

require github.com/jicksta/ranked-pairs-voting/sys v0.0.0-00010101000000-000000000000

require (
	github.com/jicksta/ranked-pairs-voting v0.0.0-00010101000000-000000000000 // indirect
	github.com/jicksta/ranked-pairs-voting/internal v0.0.0-00010101000000-000000000000 // indirect
	github.com/mattn/go-runewidth v0.0.9 // indirect
	github.com/olekukonko/tablewriter v0.0.5 // indirect
)
