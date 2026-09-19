// Integration coverage lives beside provisioning so it can use real git worktrees.
#[cfg(test)]
mod integration_tests {
    use crate::git;
    use std::fs;

    #[test]
    fn private_replica_provisions_exact_commit() {
        let root = std::env::temp_dir().join(format!("swath-task-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "one").unwrap();
        let source = git::prepare_project_source(root.to_str().unwrap()).unwrap();
        let commit = git::resolve_ref(&source, "HEAD").unwrap();
        let replica = root.join("replica.git");
        let worktree = root.join("task");
        git::provision_worktree(&source, &replica, &worktree, &commit).unwrap();
        assert_eq!(fs::read_to_string(worktree.join("a.txt")).unwrap(), "one");
        let _ = fs::remove_dir_all(root);
    }
}
