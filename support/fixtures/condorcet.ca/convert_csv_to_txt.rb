#!/usr/bin/env ruby
require 'ap'
require 'pry'
require 'active_support/all'

def simplify_name(name)
  name.upcase.gsub(/\W+/, "_").chomp("_")
end

FILE_NAME = ARGV.first
abort "Must supply a scenario CSV file as argument" if FILE_NAME.blank?

FILE_LINES = File.read(FILE_NAME).lines
CANDIDATES = FILE_LINES.first.scan(/"([^"]+)"/).flatten.map do |name|
  simplify_name(name)
end

VOTES = FILE_LINES[1..-1].map do |line|
  priorities = line.strip.split(/\s*,\s*/).map! { |n| n.to_i - 1 }
  
  # Have to handle ties, sorting, and name lookup all at once
  Array.new(priorities.max+1) { [] }.tap do |prefs|
    priorities.each.with_index do |priority,candidate_index|
      prefs[priority] << CANDIDATES[candidate_index]
    end
  end
end

VOTES.each.with_index do |vote, voter_index|
  voter_name = "VOTER_#{voter_index + 1}"
  formatted_ties = vote.reject(&:blank?).map { |priority| priority.join("=") }
  puts "#{voter_name}\t#{formatted_ties.join("\t")}"
end
