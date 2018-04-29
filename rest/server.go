package main

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/jicksta/ranked-pairs-voting"
	"os"
	//"net/http"
)

func main() {
	filename := "fixtures/dnd-campaign-preferences.txt"
	election := electionFromFile(filename)
	memoryStore := trp.NewMemoryStore()
	memoryStore.CreateElection("dnd", election.Ballots)
	startServer(memoryStore)
}

func startServer(store trp.ElectionStore) {
	r := gin.Default()

	r.GET("/elections", func(c *gin.Context) {
		c.JSON(200, store.GetElections())
	})

	r.POST("/elections", func(c *gin.Context) {
		if postBody, err := c.GetRawData(); err == nil {
			deserialized := &trp.Election{}
			json.Unmarshal(postBody, deserialized)
			e, _ := store.CreateElection(deserialized.ElectionID, deserialized.Ballots)
			c.JSON(201, e.Results())
		} else {
			c.JSON(422, gin.H{"error": err.Error()})
		}
	})

	r.GET("/elections/:electionID", func(c *gin.Context) {
		electionID := c.Param("electionID")
		election, err := store.GetElection(electionID)
		if err != nil {
			c.JSON(404, gin.H{"error": "Cannot find election with ID " + electionID})
			return
		}
		results := election.Results()
		c.JSON(200, results)
	})

	r.POST("/elections/:electionID/ballots", func(c *gin.Context) {
		ballot := &trp.Ballot{}
		if postBody, err := c.GetRawData(); err == nil {
			json.Unmarshal(postBody, ballot)
		} else {
			c.JSON(422, gin.H{"error": err.Error()})
			return
		}

		electionID := c.Param("electionID")
		if results, err := store.SaveBallot(electionID, ballot); err == nil {
			c.JSON(201, results)
		} else {
			c.JSON(404, gin.H{"error": "Cannot find election with ID " + electionID})
		}
	})

	r.StaticFS("/webui", gin.Dir("./rest/webui", true))
	r.Run() // listen and serve on 0.0.0.0:8080
}

func electionFromFile(filename string) *trp.Election {
	f, err := os.Open(filename)
	if err != nil {
		panic(err)
	}
	defer f.Close()

	if election, err := trp.ReadElection(filename, f); err == nil {
		return election
	} else {
		panic(err)
	}
}
