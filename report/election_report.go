package report

import (
	"fmt"
	trp "github.com/jicksta/ranked-pairs-voting"
	"github.com/olekukonko/tablewriter"
	"io"
	"strings"
)

type ElectionReport struct {
	Results *trp.ElectionResults
}

func NewElectionReport(results *trp.ElectionResults) *ElectionReport {
	return &ElectionReport{
		Results: results,
	}
}

func (er *ElectionReport) PrintTallyTable(writer io.Writer) {
	t := er.Results.Tally
	matrix := t.Matrix()
	table := tablewriter.NewWriter(writer)

	// Configure for Markdown table formatting
	table.SetBorders(tablewriter.Border{Left: true, Top: false, Right: true, Bottom: false})
	table.SetCenterSeparator("|")

	var headingsWithPrefixes = []string{"A"}
	for _, header := range matrix.Headings {
		headingsWithPrefixes = append(headingsWithPrefixes, "B="+header)
	}
	table.SetHeader(headingsWithPrefixes)

	for i, rowChoice := range matrix.Headings {
		rowPairs := matrix.RowsColumns[i]

		var cells = []string{"A=" + strings.ToUpper(rowChoice)}
		for j, pair := range rowPairs {
			if pair == nil {
				cells = append(cells, "")
				continue
			}
			columnChoice := matrix.Headings[j]
			var cellText string
			if columnChoice == pair.A {
				cellText = fmt.Sprintf("A=%d  B=%d  (%d)", pair.FavorA, pair.FavorB, pair.Ties)
			} else {
				cellText = fmt.Sprintf("A=%d  B=%d  (%d)", pair.FavorB, pair.FavorA, pair.Ties)
			}
			cells = append(cells, cellText)
		}

		table.Append(cells)
	}

	table.Render()
}

func (er *ElectionReport) PrintRankedPairsTable(writer io.Writer) {
	rp := er.Results.RankedPairs
	table := tablewriter.NewWriter(writer)
	table.SetHeader([]string{"Rank", "A", "B", "# A", "# B", "# Ties", "Cyclical?", "Won by"})

	// Configure for Markdown table formatting
	table.SetBorders(tablewriter.Border{Left: true, Top: false, Right: true, Bottom: false})
	table.SetCenterSeparator("|")

	for i, pair := range *rp.LockedPairs {
		var isCyclical bool
		for _, cyclicalIndex := range rp.CyclicalLockedPairsIndices {
			if i == cyclicalIndex {
				isCyclical = true
				break
			}
		}
		table.Append([]string{
			fmt.Sprint(i + 1),
			pair.A,
			pair.B,
			fmt.Sprint(pair.FavorA),
			fmt.Sprint(pair.FavorB),
			fmt.Sprint(pair.Ties),
			fmt.Sprint(isCyclical),
			fmt.Sprint(pair.VictoryMagnitude()),
		})
	}

	table.Render()
}
