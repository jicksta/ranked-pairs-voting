#!/usr/bin/env ruby
require 'active_support/all'

def new_voter_id(length: 8)
  SecureRandom.hex.upcase[0,length]
end

def percent_vote(percentage, *candidates)
  percentage.times do
    puts "#{new_voter_id} " + candidates.join(" ")
  end
end

percent_vote(42, :Memphis, :Nashville, :Chattanooga, :Knoxville)
percent_vote(26, :Nashville, :Chattanooga, :Knoxville, :Memphis)
percent_vote(15, :Chattanooga, :Knoxville, :Nashville, :Memphis)
percent_vote(17, :Knoxville, :Chattanooga, :Nashville, :Memphis)


# Had to remove the following to avoid a tie
# C3BF28 I A H G B
