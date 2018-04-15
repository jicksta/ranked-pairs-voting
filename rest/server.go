package main

import (
  "os"
  "github.com/jicksta/ranked-pairs-voting"
  "github.com/gin-gonic/gin"
  "encoding/json"
  //"net/http"
)

func main() {
  filename := "fixtures/dnd-campaign-preferences.txt"
  election := electionFromFile(filename)
  memoryStore := trp.NewMemoryStore()
  memoryStore.CreateElection("dnd", election.Ballots)
  startServer(memoryStore)
}

func startServer(store trp.ElectionPersistence) {
  r := gin.Default()

  r.GET("/elections", func(c *gin.Context) {
    c.JSON(200, store.GetElections())
  })

  r.GET("/elections/:electionID", func(c *gin.Context) {
    electionID := c.Param("electionID")
    election, err := store.GetElection(electionID)
    if err != nil {
      c.JSON(404, gin.H{"error": "Cannot find election with ID " + electionID})
      return
    }
    c.JSON(200, election.Results())
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
      c.JSON(200, results)
    } else {
      c.JSON(404, gin.H{"error": "Cannot find election with ID " + electionID})
    }
  })

  r.Run() // listen and serve on 0.0.0.0:8080
}

func electionFromFile(filename string) *trp.CompletedElection {
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
