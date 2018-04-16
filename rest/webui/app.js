window.onload = () => {
  const electionsList = document.getElementById("election-list");
  fetch("/elections")
      .then(r => r.json())
      .then(ids => ids.map(id => fetch("/elections/" + id).then(r => r.json())))
      .then(responses => Promise.all(responses))
      .then(elections => {
        elections.forEach(e => {
          electionsList.innerHTML += electionHTML(e)
        })
      });
};

function electionHTML(election) {
  const voters = election.Election.Ballots.map(b => b.VoterID);
  const listItems = voters.map(voter => `<li>${voter}</li>`);
  return `<ul>${listItems.join("\n")}</ul>`
}
