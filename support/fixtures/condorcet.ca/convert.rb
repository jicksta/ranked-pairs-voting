#!/usr/bin/env ruby
require 'ap'
require 'pry'

FILE_LINES = File.read("scenario5.csv").lines
CANDIDATES = FILE_LINES.first.scan(/"([^"]+)"/).flatten

VOTES = FILE_LINES[1..-1].map do |line|
  line.strip.split(/\s*,\s*/).map { |n| CANDIDATES[n.to_i - 1] }.flatten
end

p candidates: CANDIDATES
puts
binding.pry
