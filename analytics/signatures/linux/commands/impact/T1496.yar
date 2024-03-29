rule T1496_resource_hijacking_cowrie {

    meta:
        data_source = "Cowrie"
        technique_name = "T1496 Resource Hijacking"
        description = "Looking for activity related to resource hijacking."
        author = "ssafuze"

    strings:
        $source = "cowrie"
        $s1 = "[Mm]iner" // attack seen searching for string perhaps to identify cryptomining process
        $s2 = "c3pool" // known mining pool 

    condition:
        $source and ($s1 or $s2)
}