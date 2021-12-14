module github.com/jicksta/ranked-pairs-voting/sys

go 1.17

replace github.com/jicksta/ranked-pairs-voting => ../

replace github.com/jicksta/ranked-pairs-voting/report => ../report

replace github.com/jicksta/ranked-pairs-voting/internal => ../internal

require (
	github.com/jicksta/ranked-pairs-voting v0.0.0-00010101000000-000000000000
	github.com/olekukonko/tablewriter v0.0.5
)

require (
	github.com/jicksta/ranked-pairs-voting/internal v0.0.0-00010101000000-000000000000 // indirect
	github.com/mattn/go-runewidth v0.0.9 // indirect
)
